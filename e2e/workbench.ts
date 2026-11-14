import * as assert from 'node:assert/strict';
import { E2E_TIMEOUT_MS, E2E_POLL_MS } from './timeouts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** ページ内で { x, y }（またはその Promise）を返す式を評価し、その座標をクリックする。 */
export async function clickWorkbenchElement(locateExpression: string): Promise<void> {
  const userData = process.env.VSREVIEW_E2E_USER_DATA;
  assert.ok(userData, 'E2E の user-data-dir が未指定です');
  const port = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const targets = (await (
    await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(E2E_TIMEOUT_MS) })
  ).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find(({ type }) => type === 'page');
  assert.ok(target, 'VS Code の画面が見つかりません');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const wait = <T>(start: (resolve: (value: T) => void, reject: (error: Error) => void) => void): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CDP の応答が期限内に届きませんでした')), E2E_TIMEOUT_MS);
      socket.onclose = () => reject(new Error('CDP の接続が閉じられました'));
      socket.onerror = () => reject(new Error('CDP の接続に失敗しました'));
      start(resolve, reject);
    }).finally(() => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    });
  };
  let id = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
    wait((resolve, reject) => {
      const current = ++id;
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          const reply = JSON.parse(event.data) as {
            id: number;
            error?: unknown;
            result: Record<string, unknown>;
          };
          if (reply.id === current) {
            if (reply.error) {
              reject(new Error(JSON.stringify(reply.error)));
            } else {
              resolve(reply.result);
            }
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  try {
    await wait<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const evaluated = await request('Runtime.evaluate', {
      expression: locateExpression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = evaluated.result as { value?: { x: number; y: number } };
    if (!result.value || !Number.isFinite(result.value.x) || !Number.isFinite(result.value.y)) {
      const widget = await request('Runtime.evaluate', {
        expression: `document.querySelector('.quick-input-widget')?.innerText`,
        returnByValue: true,
      });
      throw new Error(JSON.stringify({ evaluated, widget }));
    }
    await request('Input.dispatchMouseEvent', { type: 'mousePressed', ...result.value, button: 'left', clickCount: 1 });
    await request('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...result.value,
      button: 'left',
      clickCount: 1,
    });
  } finally {
    socket.close();
  }
}

/** 要素を返す式を期限付きで評価し、表示された要素の中央座標を返すページ内の式を作る。 */
export function visibleElementExpression(elementExpression: string, failureMessage: string): string {
  return `(async () => {
    const deadline = Date.now() + ${E2E_TIMEOUT_MS / 2};
    while (Date.now() < deadline) {
      const element = ${elementExpression};
      const rect = element?.getBoundingClientRect();
      if (rect?.width > 0 && rect.height > 0) {
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      await new Promise(resolve => setTimeout(resolve, ${E2E_POLL_MS}));
    }
    throw new Error(${JSON.stringify(failureMessage)});
  })()`;
}
