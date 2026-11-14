import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { clickWorkbenchElement } from '../e2e/workbench';
import { E2E_TIMEOUT_MS } from '../e2e/timeouts';
import { temporaryDirectory } from './fixtures';

describe('workbench', () => {
  it.each(['user-data-dir未設定', '画面なし'])('CDP の接続先がなければ接続せずに拒否する: %s', async (missing) => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'DevToolsActivePort'), '1234\n');
    vi.stubEnv('VSREVIEW_E2E_USER_DATA', missing === 'user-data-dir未設定' ? undefined : directory);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve([{ type: 'worker' }]) }));
    const socket = vi.fn();
    vi.stubGlobal('WebSocket', socket);
    await expect(clickWorkbenchElement('({ x: 10, y: 20 })')).rejects.toThrow(
      missing === 'user-data-dir未設定' ? 'user-data-dir' : '画面が見つかりません',
    );
    expect(socket).not.toHaveBeenCalled();
  });
  it.each([
    ['接続タイムアウト', '拒否'],
    ['接続切断', '拒否'],
    ['接続エラー', '拒否'],
    ['要求タイムアウト', '拒否'],
    ['要求中の切断', '拒否'],
    ['要求エラー', '拒否'],
    ['壊れた応答', '拒否'],
    ['CDP エラー', '拒否'],
    ['クリック', 'クリック'],
    ['異なるID', 'クリック'],
    ['座標なし', '拒否'],
  ])('CDP は %s で %s して接続を閉じる', async (scenario, expected) => {
    const coordinates = scenario === '異なるID' ? { x: 57, y: 93 } : { x: 10, y: 20 };
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'DevToolsActivePort'), '1234\n');
    vi.stubEnv('VSREVIEW_E2E_USER_DATA', directory);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ json: () => Promise.resolve([{ type: 'page', webSocketDebuggerUrl: 'ws://localhost' }]) }),
    );
    let connected!: (socket: FakeSocket) => void;
    const created = new Promise<FakeSocket>((resolve) => {
      connected = resolve;
    });
    let requested!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    class FakeSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      close = vi.fn();
      send = vi.fn((data: string) => {
        requested();
        const { id, method } = JSON.parse(data) as { id: number; method: string };
        if (scenario === '壊れた応答') {
          this.onmessage?.({ data: '{' } as MessageEvent<string>);
        } else if (scenario === 'CDP エラー') {
          this.onmessage?.({ data: JSON.stringify({ id, error: 'rejected' }) } as MessageEvent<string>);
        } else if (['クリック', '異なるID', '座標なし'].includes(scenario)) {
          if (scenario === '異なるID') {
            this.onmessage?.({ data: JSON.stringify({ id: id + 1, error: 'ignore' }) } as MessageEvent<string>);
          }
          const result =
            method === 'Runtime.evaluate' ? { result: scenario === '座標なし' ? {} : { value: coordinates } } : {};
          this.onmessage?.({ data: JSON.stringify({ id, result }) } as MessageEvent<string>);
        }
      });
      constructor() {
        connected(this);
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
    const expression = `(${JSON.stringify(coordinates)})`;
    const pending = clickWorkbenchElement(expression);
    const failures: Record<string, string | typeof SyntaxError> = {
      接続タイムアウト: 'CDP の応答が期限内に届きませんでした',
      接続切断: 'CDP の接続が閉じられました',
      接続エラー: 'CDP の接続に失敗しました',
      要求タイムアウト: 'CDP の応答が期限内に届きませんでした',
      要求中の切断: 'CDP の接続が閉じられました',
      要求エラー: 'CDP の接続に失敗しました',
      壊れた応答: SyntaxError,
      'CDP エラー': 'rejected',
      座標なし: 'evaluated',
    };
    const result =
      expected === 'クリック'
        ? expect(pending).resolves.toBeUndefined()
        : expect(pending).rejects.toThrow(failures[scenario]);
    const socket = await created;
    if (!scenario.startsWith('接続')) {
      socket.onopen?.();
      await requestStarted;
    }
    if (scenario.endsWith('タイムアウト')) {
      await vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS);
    } else if (scenario.endsWith('切断')) {
      socket.onclose?.();
    } else if (scenario.endsWith('エラー') && scenario !== 'CDP エラー') {
      socket.onerror?.();
    }
    await result;
    expect(socket.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (expected === 'クリック') {
      const requests = socket.send.mock.calls.map(
        ([data]) => JSON.parse(data) as { method: string; params: Record<string, unknown> },
      );
      expect(requests.map(({ method }) => method)).toEqual([
        'Runtime.evaluate',
        'Input.dispatchMouseEvent',
        'Input.dispatchMouseEvent',
      ]);
      expect(requests[0]?.params).toMatchObject({ expression });
      const mouse = { ...coordinates, button: 'left', clickCount: 1 };
      expect(requests.slice(1).map(({ params }) => params)).toEqual([
        { ...mouse, type: 'mousePressed' },
        { ...mouse, type: 'mouseReleased' },
      ]);
    }
  });
});
