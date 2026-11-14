import { comparisonKey } from '../core/comparisons';
import { PromiseCache } from '../core/collections';
import type { ChangedFile, Commit } from '../core/gitParsing';
import * as vscode from 'vscode';
import { GitClient, isNotRepository, type GitFactory } from '../git/client';
import { showError } from './common';
export const CHANGED_FILES_CACHE_LIMIT = 32;
export class ChangedFiles {
  private readonly changedFiles = new PromiseCache<ChangedFile[]>(CHANGED_FILES_CACHE_LIMIT);
  constructor(private readonly access: RepositoryAccess) {}
  get(repo: string, commit: Commit): Promise<ChangedFile[]> {
    this.access.assertKnown(repo);
    return this.changedFiles.get(comparisonKey({ repo, commit, parent: commit.parents[0] ?? '' }), () =>
      this.access.client(repo).files(commit),
    );
  }
}
export class RepositoryAccess {
  private generation = 0;
  private roots = new Set<string>();
  constructor(private readonly factory: GitFactory) {}
  isKnown(repo: string): boolean {
    return this.roots.has(repo);
  }
  all(): readonly string[] {
    return [...this.roots];
  }
  assertKnown(repo: string): void {
    if (!this.isKnown(repo)) {
      throw new Error('ワークスペース外のリポジトリは参照できません');
    }
  }
  client(repo: string): GitClient {
    this.assertKnown(repo);
    return this.factory(repo);
  }
  async discover(folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? []): Promise<void> {
    const generation = ++this.generation;
    const results = await Promise.allSettled(
      folders.filter((folder) => folder.uri.scheme === 'file').map((folder) => GitClient.resolve(folder.uri.fsPath)),
    );
    if (generation !== this.generation) {
      return;
    }
    const roots: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        roots.push(result.value.root);
      } else if (!isNotRepository(result.reason)) {
        showError(result.reason);
      }
    }
    this.roots = new Set(roots);
  }
}

// 展開要求後の rebase/GC やリポジトリ削除は通知せず、到達確認自体の失敗では元のエラーを通知する。
export async function showRepositoryError(
  access: RepositoryAccess,
  repo: string,
  hash: string,
  error: unknown,
): Promise<void> {
  if (
    access.isKnown(repo) &&
    (await access
      .client(repo)
      .isReachable(hash)
      .catch(() => true))
  ) {
    showError(error);
  }
}
