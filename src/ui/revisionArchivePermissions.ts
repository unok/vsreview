import * as vscode from 'vscode';
import { PromiseCache, SerialQueue } from '../core/collections';
import { repositoryId } from '../git/repositoryId';
import { showWarning } from './common';
type ArchivePullRequest = { number: number; head: string };
const PERMISSION_PREFIX = 'vsreview.archivePermission.';
export function archivePermissionKey(repo: string, pullRequest?: ArchivePullRequest): string {
  return `${PERMISSION_PREFIX}${repositoryId(repo)}${pullRequest === undefined ? '' : `.pr.${pullRequest.number}.${pullRequest.head}`}`;
}
export class RevisionArchivePermissions {
  private generation = 0;
  private resetting: Promise<void> = Promise.resolve();
  private readonly writes = new SerialQueue();
  private readonly pending = new PromiseCache<boolean>();
  constructor(private readonly state: vscode.Memento) {}
  async allowed(repo: string, pullRequest?: ArchivePullRequest): Promise<boolean> {
    await this.resetting;
    const key = archivePermissionKey(repo, pullRequest);
    const generation = this.generation;
    return this.pending.get(key, async () => {
      // PromiseCache に登録した後で finally の削除を行う。保存済みの値もキャッシュし続けない。
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
          `${repo}${pullRequest === undefined ? '' : ` の外部 PR #${pullRequest.number} (${pullRequest.head})`} の過去のソースを展開します。展開したファイルを開くと、他の拡張がそのリビジョンの設定ファイルを読み込んでコードを実行する可能性があります`,
          { modal: true },
          '許可',
          '拒否',
        );
        if (answer === undefined) {
          return false;
        }
        if (generation !== this.generation) {
          return false;
        }
        const allowed = answer === '許可';
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
        if (key.startsWith(PERMISSION_PREFIX)) {
          await this.state.update(key, undefined);
        }
      }
    });
    return this.resetting;
  }
}
