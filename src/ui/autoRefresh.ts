import * as vscode from 'vscode';
import { RefreshQueue } from '../core/refreshQueue';
import { shortHash, uncommittedLabel, UNCOMMITTED_CHANGED_LABEL } from '../core/presentation';
import { comparisonKey } from '../core/comparisons';
import { showError, showStatus } from './common';
import type { RepositoryAccess } from './repositories';
import type { CommitsTree } from './trees';
import type { RewrittenComments } from './rewritten';
import type { ReviewDocuments } from './documents';
export const AUTO_REFRESH_DEBOUNCE_MS = 300;

export class AutoRefresh implements vscode.Disposable {
  private watchers: vscode.Disposable[] = [];
  private generation = 0;
  private enabled = false;
  private disposed = false;
  private notified = new Set<string>();
  private readonly queue = new RefreshQueue(() => this.refresh(), showError, AUTO_REFRESH_DEBOUNCE_MS);
  constructor(
    private readonly access: RepositoryAccess,
    private readonly commits: CommitsTree,
    private readonly rewritten: RewrittenComments,
    private readonly documents: ReviewDocuments,
  ) {}
  async rewatch(options: { refresh?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    this.clearWatchers();
    this.queue.cancel();
    this.enabled = !this.disposed && vscode.workspace.getConfiguration('vsreview').get<boolean>('autoRefresh') === true;
    if (!this.enabled) {
      return;
    }
    for (const root of this.access.all()) {
      try {
        const { gitDir, commonDir } = await this.access.client(root).directories();
        if (generation !== this.generation || this.disposed) {
          return;
        }
        // RelativePattern はワークスペース外も監視でき、VS Code の watcher と一緒に解放できる。
        for (const [dir, pattern] of [
          [gitDir, 'HEAD'],
          [commonDir, '{refs/heads/**,packed-refs}'],
        ] as const) {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(dir), pattern),
          );
          const request = (): void => {
            if (generation === this.generation && !this.disposed) {
              this.queue.request();
            }
          };
          this.watchers.push(
            watcher,
            watcher.onDidChange(request),
            watcher.onDidCreate(request),
            watcher.onDidDelete(request),
          );
        }
      } catch (error) {
        if (generation === this.generation && !this.disposed) {
          showError(error);
        }
      }
    }
    if (generation === this.generation && !this.disposed && options.refresh !== false) {
      this.queue.request();
    }
  }
  private async refresh(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    const generation = this.generation;
    await this.commits.reload();
    if (generation !== this.generation || this.disposed) {
      return;
    }
    await this.rewritten.refresh();
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const current = new Set<string>();
    for (const target of await this.documents.openDiffTargets()) {
      const key = comparisonKey(target);
      if (current.has(key) || !this.rewritten.has(target)) {
        continue;
      }
      current.add(key);
      if (!this.notified.has(key)) {
        showStatus(
          target.uncommitted
            ? `開いている差分の${uncommittedLabel(target.uncommitted.kind)}は${UNCOMMITTED_CHANGED_LABEL}です`
            : target.pullRequest
              ? `開いている差分の PR #${target.pullRequest.number}（${shortHash(target.commit)}）は書き換え済みです`
              : `開いている差分のコミット ${shortHash(target.commit)} は書き換え済みです`,
        );
      }
    }
    this.notified = current;
  }
  private clearWatchers(): void {
    for (const watcher of this.watchers.splice(0)) {
      watcher.dispose();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.generation++;
    this.queue.dispose();
    this.clearWatchers();
  }
}
