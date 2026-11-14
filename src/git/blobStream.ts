// ls-tree の NUL 区切りと cat-file の長さ付き本文を、本文全体を保持せず読む。
export class GitStreamReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  constructor(
    source: AsyncIterable<Buffer>,
    private readonly command = 'git',
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async take(size: number): Promise<Buffer> {
    while (!this.buffered.length) {
      const next = await this.iterator.next();
      if (next.done) {
        return Buffer.alloc(0);
      }
      this.buffered = next.value;
    }
    const chunk = this.buffered.subarray(0, size);
    this.buffered = this.buffered.subarray(chunk.length);
    return chunk;
  }
  async record(separator: number, limit: number): Promise<Buffer | undefined> {
    const parts: Buffer[] = [];
    let length = 0;
    while (true) {
      const chunk = await this.take(Number.MAX_SAFE_INTEGER);
      if (!chunk.length) {
        if (length) {
          throw new Error(`${this.command} の出力が不完全です`);
        }
        return undefined;
      }
      const end = chunk.indexOf(separator);
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      length += part.length;
      if (length > limit) {
        throw new Error(`${this.command} のレコードが長すぎます`);
      }
      parts.push(part);
      if (end >= 0) {
        this.buffered = chunk.subarray(end + 1);
        return Buffer.concat(parts, length);
      }
    }
  }
}
export interface RevisionBlob {
  path: string;
  size: number;
  executable: boolean;
}
export async function copyBlob(
  reader: GitStreamReader,
  size: number,
  write: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  let remaining = size;
  while (remaining) {
    const chunk = await reader.take(remaining);
    if (!chunk.length) {
      throw new Error('git cat-file の出力が不完全です');
    }
    await write(chunk);
    remaining -= chunk.length;
  }
  if (!(await reader.take(1)).equals(Buffer.from('\n'))) {
    throw new Error('git cat-file の形式が不正です');
  }
}
