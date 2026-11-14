export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name) ?? [];
    group.push(item);
    groups.set(name, group);
  }
  return groups;
}

export function compareNames(a: string, b: string): number {
  // 実行環境のロケールによらず同じ順序を保つ。
  return a < b ? -1 : a > b ? 1 : 0;
}

export class PromiseCache<T> {
  private readonly values = new Map<string, Promise<T>>();
  constructor(private readonly limit?: number) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('キャッシュ上限は正の整数が必要です');
    }
  }
  get(key: string, load: () => Promise<T>): Promise<T> {
    let pending = this.values.get(key);
    // 上限超過時に最も長く使われていない値を追い出すため、ヒット時も末尾へ移す。
    this.values.delete(key);
    if (!pending) {
      pending = load();
      const current = pending;
      void pending.catch(() => {
        if (this.values.get(key) === current) {
          this.values.delete(key);
        }
      });
    }
    this.values.set(key, pending);
    if (this.limit !== undefined && this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value!);
    }
    return pending;
  }
  delete(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  idle(): Promise<unknown> {
    return this.tail;
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    // 各操作の失敗を呼び出し元へ返し、後続の操作は継続する。
    this.tail = next.catch(() => undefined);
    return next;
  }
}

// 失敗した処理以外の実行中タスクも回収してから返し、後始末との競合を防ぐ。
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  visit: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('並列数は正の整数が必要です');
  }
  let next = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]!;
        try {
          await visit(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}
