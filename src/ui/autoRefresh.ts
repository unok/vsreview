import * as vscode from 'vscode';
import { RefreshQueue } from '../core/refreshQueue';
import { shortHash, uncommittedLabel, UNCOMMITTED_CHANGED_LABEL } from '../core/presentation';
import { comparisonKey } from '../core/comparisons';
import { isWithin, repoRelativePath } from '../core/paths';
import type { UncommittedChanges } from '../core/uncommitted';
import { captureUncommittedChanges, type CaptureUncommitted } from '../git/uncommitted';
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
  private history = false;
  private changes = new Map<string, { index: boolean; paths: Set<string> }>();
  private readonly queue = new RefreshQueue(() => this.refresh(), showError, AUTO_REFRESH_DEBOUNCE_MS);
  constructor(
    private readonly access: RepositoryAccess,
    private readonly commits: CommitsTree,
    private readonly rewritten: RewrittenComments,
    private readonly documents: ReviewDocuments,
    private readonly captureUncommitted: CaptureUncommitted = captureUncommittedChanges,
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
          [gitDir, 'index'],
          [root, '**'],
        ] as const) {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(dir), pattern),
          );
          const request = (uri: vscode.Uri): void => {
            if (generation === this.generation && !this.disposed) {
              if (pattern === '**' || pattern === 'index') {
                const path = repoRelativePath(root, uri.fsPath);
                if (pattern === '**' && (!isWithin(root, uri.fsPath) || path.split('/').includes('.git'))) {
                  return;
                }
                const change = this.changes.get(root) ?? { index: false, paths: new Set<string>() };
                if (pattern === 'index') {
                  change.index = true;
                } else {
                  change.paths.add(path);
                }
                this.changes.set(root, change);
              } else {
                this.history = true;
              }
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
      this.history = true;
      this.queue.request();
    }
  }
  private async refresh(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    const generation = this.generation;
    const history = this.history;
    const changes = this.changes;
    this.history = false;
    this.changes = new Map();
    const roots = history ? undefined : await this.uncommittedRoots(changes, generation);
    if (roots?.size === 0) {
      return;
    }
    if (generation !== this.generation || this.disposed) {
      return;
    }
    const snapshots = new Map<string, Promise<UncommittedChanges>>();
    const captureUncommitted: CaptureUncommitted = (git) => {
      let pending = snapshots.get(git.root);
      if (!pending) {
        pending = this.captureUncommitted(git);
        snapshots.set(git.root, pending);
      }
      return pending;
    };
    if (history || (this.commits.git && roots?.has(this.commits.git.root))) {
      await this.commits.reload({ captureUncommitted, onlyIfChanged: !history });
    }
    if (generation !== this.generation || this.disposed) {
      return;
    }
    await this.rewritten.refresh({ captureUncommitted, onlyIfChanged: !history, ...(roots ? { roots } : {}) });
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
  private async uncommittedRoots(
    changes: Map<string, { index: boolean; paths: Set<string> }>,
    generation: number,
  ): Promise<Set<string>> {
    const roots = new Set<string>();
    for (const [root, change] of changes) {
      if (!this.access.isKnown(root)) {
        continue;
      }
      if (change.index) {
        roots.add(root);
        continue;
      }
      try {
        const ignored = await this.access.client(root).ignoredPaths([...change.paths]);
        if ([...change.paths].some((path) => !ignored.has(path))) {
          roots.add(root);
        }
      } catch (error) {
        // 無視判定の失敗で更新を止めると、一覧が古いまま残る。
        if (generation === this.generation && !this.disposed) {
          showError(error);
        }
        roots.add(root);
      }
    }
    return roots;
  }
  private clearWatchers(): void {
    this.history = false;
    this.changes = new Map();
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
