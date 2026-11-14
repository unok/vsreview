import { describe, expect, it } from 'vitest';
import { GitStreamReader, copyBlob } from '../src/git/blobStream';

async function* chunks(...parts: string[]) {
  for (const part of parts) {
    yield await Promise.resolve(Buffer.from(part));
  }
}
describe('blobStream', () => {
  it('チャンク境界にまたがるレコードと本文を空ファイルも含めて読む', async () => {
    const reader = new GitStreamReader(chunks('one', '\0two\0', 'header\n', 'bo', 'dy\n\n'));
    expect((await reader.record(0, 10))?.toString()).toBe('one');
    expect((await reader.record(0, 10))?.toString()).toBe('two');
    expect((await reader.record(10, 10))?.toString()).toBe('header');
    const body: Buffer[] = [];
    await copyBlob(reader, 4, async (chunk) => {
      body.push(chunk);
      await Promise.resolve();
    });
    expect(Buffer.concat(body).toString()).toBe('body');
    await copyBlob(reader, 0, async () => {
      await Promise.reject(new Error('空本文の書き込み'));
    });
    expect(await reader.record(0, 10)).toBeUndefined();
  });
  it.each([
    ['', 0],
    ['ab', 3],
    ['abc', 3],
  ] as const)('レコード %j は上限 %i バイト以内なら受理する', async (text, limit) => {
    expect((await new GitStreamReader(chunks(`${text}\0`)).record(0, limit))?.toString()).toBe(text);
  });
  it('64 MiB を超える列挙を一度に保持せず処理する', async () => {
    const count = 70_000;
    let found = 0;
    const record = Buffer.from(`${'x'.repeat(1024)}\0`);
    async function* listing() {
      for (let i = 0; i < count; i++) {
        if (i > found) {
          throw new Error('未消費のレコードを先読みしました');
        }
        yield await Promise.resolve(record);
      }
    }
    const reader = new GitStreamReader(listing());
    while (await reader.record(0, 2048)) {
      found++;
    }
    expect(found).toBe(count);
  });
  it('レコード・本文の途中終了、長すぎるレコード、不正終端を拒否する', async () => {
    await expect(new GitStreamReader(chunks('partial')).record(0, 10)).rejects.toThrow('不完全');
    await expect(new GitStreamReader(chunks('ab', 'cd\0')).record(0, 3)).rejects.toThrow('長すぎ');
    await expect(new GitStreamReader(chunks('long\0')).record(0, 2)).rejects.toThrow('長すぎ');
    await expect(copyBlob(new GitStreamReader(chunks('a')), 2, () => Promise.resolve())).rejects.toThrow('不完全');
    await expect(copyBlob(new GitStreamReader(chunks('a!')), 1, () => Promise.resolve())).rejects.toThrow('形式');
  });
});
