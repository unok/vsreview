import './fixtures';
import type * as vscode from 'vscode';
import { window, docs, commands, textDocument, Uri } from './vscodeMock';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clickCommentInput, createCommentInput } from '../e2e/commentInput';
import { clickWorkbenchElement } from '../e2e/workbench';
import { E2E_POLL_MS, E2E_TIMEOUT_MS } from '../e2e/timeouts';

vi.mock('../e2e/workbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../e2e/workbench')>()),
  clickWorkbenchElement: vi.fn(),
}));
const uri = Uri.from({ scheme: 'comment', path: '/new-input.md' }) as vscode.Uri;
function focusInput(): void {
  window.activeTextEditor = { document: textDocument(uri, '') } as vscode.TextEditor;
}
describe('commentInput', () => {
  afterEach(() => {
    vi.mocked(clickWorkbenchElement).mockReset();
    commands.executeCommand.mockReset();
  });
  it('空の旧文書と閉じた文書を選ばず、コマンドの後から届く新規文書を待つ', async () => {
    vi.useFakeTimers();
    const old = textDocument(Uri.from({ scheme: 'comment', path: '/old.md' }) as vscode.Uri, '');
    const closed = {
      ...textDocument(Uri.from({ scheme: 'comment', path: '/closed.md' }) as vscode.Uri, ''),
      isClosed: true,
    };
    const unrelated = textDocument(Uri.file('/file.ts') as vscode.Uri, '');
    docs.push(old);
    commands.executeCommand.mockImplementationOnce(() => {
      docs.push(
        closed,
        unrelated,
        textDocument(Uri.from({ scheme: 'comment', path: '/rebuilt.md' }) as vscode.Uri, 'existing draft'),
      );
      return Promise.resolve();
    });
    let result: vscode.TextDocument | undefined;
    const pending = createCommentInput().then((document) => {
      result = document;
    });
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    expect(result).toBeUndefined();
    expect(commands.executeCommand.mock.calls).toEqual([['workbench.action.addComment']]);
    const draft = textDocument(uri, '');
    docs.push(draft);
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    await pending;
    expect(result).toBe(draft);
    expect(commands.executeCommand.mock.calls).toEqual([
      ['workbench.action.addComment'],
      ['workbench.action.focusCommentOnCurrentLine'],
    ]);
  });
  it('入力欄の生成コマンドが失敗したらエラーを返す', async () => {
    commands.executeCommand.mockRejectedValueOnce(new Error('add failed'));
    await expect(createCommentInput()).rejects.toThrow('add failed');
  });
  it('新規文書が届かなければ旧文書を使わず期限付きで失敗する', async () => {
    vi.useFakeTimers();
    docs.push(textDocument(uri, ''));
    const rejected = expect(createCommentInput()).rejects.toThrow('新しいコメント入力用文書');
    await vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('クリック後のフォーカス通知を待つ', async () => {
    vi.useFakeTimers();
    vi.mocked(clickWorkbenchElement).mockResolvedValueOnce();
    let focused = false;
    const pending = clickCommentInput(uri).then(() => {
      focused = true;
    });
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    expect(focused).toBe(false);
    focusInput();
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    await pending;
    expect(focused).toBe(true);
  });
  it('別の入力欄へフォーカスしたままなら期限付きで失敗する', async () => {
    vi.useFakeTimers();
    vi.mocked(clickWorkbenchElement).mockResolvedValueOnce();
    window.activeTextEditor = {
      document: textDocument(Uri.from({ scheme: 'comment', path: '/other.md' }) as vscode.Uri, ''),
    } as vscode.TextEditor;
    const rejected = expect(clickCommentInput(uri)).rejects.toThrow('フォーカスが移りませんでした');
    await vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('前段の入力欄が表示中でも、指定した文書の入力欄の描画を待つ', async () => {
    vi.useFakeTimers();
    const input = (model: string, x: number) => ({
      closest: () => ({ getAttribute: () => model }),
      getBoundingClientRect: () => ({ x, y: 20, width: 40, height: 10 }),
    });
    const inputs = [input('comment://vsreview/old-empty-input.md', 100)];
    let coordinates: unknown;
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      coordinates = await runInNewContext(expression, {
        document: { querySelectorAll: () => inputs },
        Date,
        setTimeout,
      });
    });
    const pending = clickCommentInput(uri);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinates).toBeUndefined();
    inputs.push(input(uri.toString(), 10));
    focusInput();
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    await pending;
    expect(coordinates).toEqual({ x: 30, y: 25 });
  });
  it('描画を待ち、非表示の入力欄を避けて表示中の入力欄をクリックする', async () => {
    vi.useFakeTimers();
    let visible = false;
    const inputs = [
      { closest: () => null, getBoundingClientRect: () => ({ x: 0, y: 0, width: 40, height: 10 }) },
      {
        closest: () => ({ getAttribute: () => uri.toString() }),
        getBoundingClientRect: () => ({ x: 100, y: 100, width: 0, height: 10 }),
      },
      {
        closest: () => ({ getAttribute: () => uri.toString() }),
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 40, height: 10 }),
      },
    ];
    let coordinates: unknown;
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      coordinates = await runInNewContext(expression, {
        document: {
          querySelectorAll: (selector: string) =>
            visible && selector === '.review-widget .monaco-editor textarea' ? inputs : [],
        },
        Date,
        setTimeout,
      });
    });
    const pending = clickCommentInput(uri);
    expect(coordinates).toBeUndefined();
    visible = true;
    focusInput();
    await vi.advanceTimersByTimeAsync(E2E_POLL_MS);
    await pending;
    expect(coordinates).toEqual({ x: 30, y: 25 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('表示されない入力欄は期限付きで失敗する', async () => {
    vi.useFakeTimers();
    vi.mocked(clickWorkbenchElement).mockImplementationOnce(async (expression) => {
      await runInNewContext(expression, { document: { querySelectorAll: () => [] }, Date, setTimeout });
    });
    const rejected = expect(clickCommentInput(uri)).rejects.toThrow('表示中のコメント入力欄がありません');
    await vi.advanceTimersByTimeAsync(E2E_TIMEOUT_MS / 2);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
