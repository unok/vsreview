import { RefreshQueue } from '../src/core/refreshQueue';
import { afterEach, describe, expect, it, vi } from 'vitest';
const DEBOUNCE_MS = 10;

describe('refreshQueue', () => {
  afterEach(() => vi.useRealTimers());
  it('連続イベントを指定した待ち時間後の1回にまとめる', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const queue = new RefreshQueue(run, vi.fn(), DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    queue.dispose();
  });
  it('実行中の連続イベントは重ねず、完了後に1回だけ再実行する', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new RefreshQueue(run, vi.fn(), DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    queue.request();
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    queue.dispose();
    finish();
  });
  it('失敗を通知して次を実行し、dispose後の予約とイベントを無視する', async () => {
    vi.useFakeTimers();
    const error = new Error('git failed');
    const run = vi.fn(() => Promise.reject(error));
    const failed = vi.fn();
    const queue = new RefreshQueue(run, failed, DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(failed).toHaveBeenCalledWith(error);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(failed).toHaveBeenCalledTimes(2);
    queue.request();
    queue.dispose();
    queue.request();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('実行終了前に新しいイベントが来たら、そのデバウンス完了まで再実行しない', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new RefreshQueue(run, vi.fn(), DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    queue.request();
    finish();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    queue.cancel();
    queue.request();
    queue.cancel();
    finish();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(2);
    queue.dispose();
  });
  it('実行中にdisposeした場合は待機中の再実行を破棄する', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new RefreshQueue(run, vi.fn(), DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    queue.request();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    queue.dispose();
    finish();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
