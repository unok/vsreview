import * as vscode from 'vscode';
import { PromiseCache, SerialQueue } from '../core/collections';
import { showWarning } from './common';
export interface RepositoryPermissionOptions<T extends unknown[]> {
  // リセットで消すキーの接頭辞。key はこの接頭辞で始め、他の許可の接頭辞と重ならない値にする。
  prefix: string;
  key: (repo: string, ...args: T) => string;
  message: (repo: string, ...args: T) => string;
  allow: string;
  deny: string;
}
// リポジトリ単位の確認の回答をワークスペースに保存する。閉じた確認は記録せず、次の要求で再表示する。
export class RepositoryPermissions<T extends unknown[]> {
  private generation = 0;
  private resetting: Promise<void> = Promise.resolve();
  private readonly writes = new SerialQueue();
  private readonly pending = new PromiseCache<boolean>();
  constructor(
    private readonly state: vscode.Memento,
    private readonly options: RepositoryPermissionOptions<T>,
  ) {}
  async allowed(repo: string, ...args: T): Promise<boolean> {
    await this.resetting;
    const key = this.options.key(repo, ...args);
    const generation = this.generation;
    return this.pending.get(key, async () => {
      // PromiseCache に登録した後、finally で削除する。保存済みの値もキャッシュし続けない。
      await Promise.resolve();
      try {
        if (generation !== this.generation) {
          return false;
        }
        const saved = this.state.get<unknown>(key);
        if (typeof saved === 'boolean') {
          return saved;
        }
        const answer = await showWarning(
          this.options.message(repo, ...args),
          { modal: true },
          this.options.allow,
          this.options.deny,
        );
        if (answer === undefined) {
          return false;
        }
        if (generation !== this.generation) {
          return false;
        }
        const allowed = answer === this.options.allow;
        return await this.writes.run(async () => {
          if (generation !== this.generation) {
            return false;
          }
          await this.state.update(key, allowed);
          return generation === this.generation && allowed;
        });
      } finally {
        // 同時の確認だけを共有する。閉じた確認は次の要求で再表示する。
        if (generation === this.generation) {
          this.pending.delete(key);
        }
      }
    });
  }
  reset(): Promise<void> {
    this.generation++;
    this.pending.clear();
    this.resetting = this.writes.run(async () => {
      for (const key of this.state.keys()) {
        if (key.startsWith(this.options.prefix)) {
          await this.state.update(key, undefined);
        }
      }
    });
    return this.resetting;
  }
}
