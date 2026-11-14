import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectQuickPick } from '../e2e/quickPick';
import { clickWorkbenchElement } from '../e2e/workbench';
import { E2E_POLL_MS, E2E_TIMEOUT_MS } from '../e2e/timeouts';

vi.mock('../e2e/workbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../e2e/workbench')>()),
  clickWorkbenchElement: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function row(label: string, x: number, width = 40, height = 10) {
  return {
    querySelector: (selector: string) => (selector === '.label-name' ? { textContent: label } : null),
    getBoundingClientRect: () => ({ x, y: 20, width, height }),
  };
}
function widget(title: string, rows: ReturnType<typeof row>[]) {
  return {
    getBoundingClientRect: () => ({ width: 100 }),
    querySelector: (selector: string) => (selector === '.quick-input-title' ? { textContent: title } : null),
    querySelectorAll: (selector: string) => (selector === '.monaco-list-row' ? rows : []),
  };
}

describe('quickPick', () => {
  it('表示待ちの後、異なるラベルの候補から一致する項目の中央をクリックする', async () => {
    vi.useFakeTimers();
    const picker = widget('エクスポート形式', [row('Markdown', 100), row('JSON', 10)]);
    let visible = false;
    const document = {
      querySelector: (selector: string) => (visible && selector === '.quick-input-widget' ? picker : null),
    };
    let coordinates: unknown;
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      coordinates = await runInNewContext(expression, { document, Date, setTimeout });
    });
    const pending = selectQuickPick('エクスポート形式', 'JSON');
    expect(coordinates).toBeUndefined();
    visible = true;
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    await pending;
    expect(coordinates).toEqual({ x: 30, y: 25 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('同じラベルの非表示行が残っていても表示中の行を選ぶ', async () => {
    vi.useFakeTimers();
    const picker = widget('エクスポート形式', [row('JSON', 100, 0), row('JSON', 100, 40, 0), row('JSON', 10)]);
    let coordinates: unknown;
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      coordinates = await runInNewContext(expression, {
        document: { querySelector: () => picker },
        Date,
        setTimeout,
      });
    });
    const pending = expect(selectQuickPick('エクスポート形式', 'JSON')).resolves.toBeUndefined();
    await Promise.all([pending, vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS / 2)]);
    expect(coordinates).toEqual({ x: 30, y: 25 });
  });

  it.each([
    ['画面なし', null],
    ['タイトル不一致', widget('別の選択', [row('JSON', 10)])],
    ['ラベル不一致', widget('エクスポート形式', [row('Markdown', 10)])],
    ['高さがない行', widget('エクスポート形式', [row('JSON', 10, 40, 0)])],
    ['幅がない行', widget('エクスポート形式', [row('JSON', 10, 0)])],
  ])('%s は CDP の期限より前に対象を示して失敗する', async (_scenario, picker) => {
    vi.useFakeTimers();
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      await runInNewContext(expression, {
        document: { querySelector: (selector: string) => (selector === '.quick-input-widget' ? picker : null) },
        Date,
        setTimeout,
      });
    });
    const pending = selectQuickPick('エクスポート形式', 'JSON');
    const rejected = expect(pending).rejects.toThrow(
      'QuickPick「エクスポート形式」の項目「JSON」が表示されませんでした',
    );
    await vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS / 2);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
