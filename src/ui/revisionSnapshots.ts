import { PromiseCache } from '../core/collections';
import { comparisonKey } from '../core/comparisons';
import { changeMaps, type CommitTarget, type ChangeMaps } from '../core/documents';
import type { Commit } from '../core/gitParsing';
import { ChangedFiles, type RepositoryAccess } from './repositories';

export const SNAPSHOT_CACHE_LIMIT = 16;
export interface RevisionSnapshot {
  target: CommitTarget;
  changes: ChangeMaps;
}

export class RevisionSnapshots {
  private readonly snapshots = new PromiseCache<RevisionSnapshot>(SNAPSHOT_CACHE_LIMIT);
  constructor(
    private readonly access: RepositoryAccess,
    private readonly changedFiles: ChangedFiles,
  ) {}
  async get(target: CommitTarget, options: { refresh?: boolean } = {}): Promise<RevisionSnapshot> {
    const key = comparisonKey(target);
    let verified: Commit | undefined;
    if (options.refresh) {
      try {
        verified = await this.commit(target);
      } catch (error) {
        this.snapshots.delete(key);
        throw error;
      }
    }
    return this.snapshots.get(key, async () => {
      const verifiedCommit = verified ?? (await this.commit(target));
      // 比較の左辺はコミットの実際の親と異なる場合があるため、検証した内容と比較用の親を組み合わせる。
      const git = this.access.client(target.repo);
      const hasParent = await git.hasCommit(target.parent);
      if (!hasParent && (verifiedCommit.parents.length || target.parent !== (await git.parent(verifiedCommit)))) {
        throw new Error('比較の左辺のコミットがローカルにありません。差分を開き直してください');
      }
      const commit = { ...verifiedCommit, parents: hasParent ? [target.parent] : [] };
      const snapshotTarget = { ...target, commit };
      return { target: snapshotTarget, changes: changeMaps(await this.changedFiles.get(target.repo, commit)) };
    });
  }
  private async commit(target: CommitTarget): Promise<Commit> {
    const commit = (await this.access.client(target.repo).log(0, 1, target.commit.hash))[0];
    if (!commit) {
      throw new Error('コミットが存在しません');
    }
    return commit;
  }
  clear(): void {
    this.snapshots.clear();
  }
}
