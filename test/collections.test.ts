import { describe, expect, it } from 'vitest';
import { SerialQueue, forEachConcurrent } from '../src/core/collections';

describe('collections', () => {
  it('上限内で全項目を処理し、空入力では実行しない', async () => {
    const visited: number[] = [];
    let active = 0;
    let peak = 0;
    await forEachConcurrent([1, 2, 3, 4, 5], 2, async (item) => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      visited.push(item);
      active--;
    });
    expect(visited.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    await forEachConcurrent([], 2, () => Promise.reject(new Error('empty')));
  });
  it('失敗後は次の項目を始めず、開始済みの処理を待って失敗を返す', async () => {
    const visited: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const pending = forEachConcurrent([1, 2, 3, 4], 2, async (item) => {
      visited.push(item);
      if (item === 1) {
        throw new Error('failed');
      }
      await gate;
      finished = true;
    });
    const rejected = expect(pending).rejects.toThrow('failed');
    await Promise.resolve();
    expect(visited).toEqual([1, 2]);
    expect(finished).toBe(false);
    release();
    await rejected;
    expect(finished).toBe(true);
    expect(visited).toEqual([1, 2]);
  });
  it.each([0, -1, 1.5, Infinity, NaN])('不正な並列数 %s を拒否する', async (limit) => {
    await expect(forEachConcurrent([], limit, async () => {})).rejects.toThrow();
  });
  it('失敗後も投入順で実行し、idle は保留中の操作を待つ', async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      await gate;
      order.push(1);
      throw new Error('first');
    });
    const failure = expect(first).rejects.toThrow('first');
    const second = queue.run(() => {
      order.push(2);
      return Promise.resolve('second');
    });
    let idle = false;
    const settled = queue.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(idle).toBe(false);
    release();
    await failure;
    expect(await second).toBe('second');
    await settled;
    expect(order).toEqual([1, 2]);
    expect(idle).toBe(true);
  });
});
