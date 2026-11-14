import { ChangedFileNodes, type ChangedFileNode } from './changedFileNodes';
import { showRepositoryError, ChangedFiles, type RepositoryAccess } from './repositories';
import type { ReviewComment } from '../core/model';
import { commitKey, reviewGroupKey } from '../core/comparisons';
import * as vscode from 'vscode';
import { basename } from 'node:path';
import { displayedFileTree } from './fileView';
import type { GitClient } from '../git/client';
import type { Commit } from '../core/gitParsing';
import { groupBy } from '../core/collections';
import {
  replaceDisplayControls,
  relativeDate,
  shortHash,
  locationLabel,
  commentCountLabel,
  rewrittenSuffix,
  uncommittedChangedSuffix,
  snapshotDateLabel,
  commentExcerpt,
} from '../core/presentation';
import type { RewrittenComments } from './rewritten';
import type { UncommittedChanges, UncommittedChange, UncommittedSnapshot } from '../core/uncommitted';
import { canonicalCommit, type FileTarget } from '../core/documents';
import { createUncommittedChanges } from '../git/uncommitted';
import { UNCOMMITTED_LABEL, UNCOMMITTED_KIND_LABELS, uncommittedLabel } from '../core/presentation';
import { showError, showStatus } from './common';

export const COMMIT_PAGE_SIZE = 50;

export type CommitNode =
  | { kind: 'commit'; repo: string; commit: Commit }
  | ChangedFileNode
  | { kind: 'more' }
  | { kind: 'uncommitted'; repo: string; changes: UncommittedChanges }
  | { kind: 'uncommittedGroup'; repo: string; change: UncommittedChange; uncommitted: UncommittedSnapshot };
type CaptureUncommitted = (git: GitClient) => Promise<UncommittedChanges>;
export class CommitsTree implements vscode.TreeDataProvider<CommitNode>, vscode.Disposable {
  private readonly treeDataChanged = new vscode.EventEmitter<CommitNode | undefined>();
  readonly onDidChangeTreeData = this.treeDataChanged.event;
  private readonly repositoryChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeRepository = this.repositoryChanged.event;
  private readonly historyChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeHistory = this.historyChanged.event;
  private commits: Commit[] = [];
  private more = false;
  private loading = false;
  private pageGeneration = 0;
  private refreshGeneration = 0;
  private repository: GitClient | undefined;
  private selected: GitClient | undefined;
  private refreshing = false;
  private revision: string | undefined;
  private uncommitted: UncommittedChanges | undefined;
  constructor(
    comments: () => readonly ReviewComment[],
    private readonly access: RepositoryAccess,
    private readonly changedFiles: ChangedFiles,
    private readonly captureUncommitted: CaptureUncommitted = (git) =>
      createUncommittedChanges(git, new Date().toISOString()),
  ) {
    this.files = new ChangedFileNodes(comments);
  }
  private readonly files: ChangedFileNodes;

  get git(): GitClient | undefined {
    return this.repository;
  }
  rerender(): void {
    this.treeDataChanged.fire(undefined);
  }
  async select(git: GitClient | undefined): Promise<void> {
    if (git) {
      this.access.assertKnown(git.root);
    }
    this.selected = git;
    await this.reload();
  }
  async reload(): Promise<void> {
    const git = this.selected;
    const generation = ++this.refreshGeneration;
    this.refreshing = true;
    try {
      const previousRoot = this.repository?.root;
      const revision = await git?.head();
      if (generation !== this.refreshGeneration) {
        return;
      }
      let changes: UncommittedChanges | undefined;
      try {
        changes = git ? await this.captureUncommitted(git) : undefined;
      } catch (error) {
        // 未コミットの取得失敗で既存のコミット履歴まで隠さない。
        if (generation === this.refreshGeneration) {
          showError(error);
        }
      }
      if (generation !== this.refreshGeneration) {
        return;
      }
      if (previousRoot === git?.root && revision === this.revision) {
        this.uncommitted = changes;
        this.rerender();
        return;
      }
      ++this.pageGeneration;
      this.loading = false;
      const count = previousRoot === git?.root ? Math.max(COMMIT_PAGE_SIZE, this.commits.length) : COMMIT_PAGE_SIZE;
      const commits = git && revision ? await git.log(0, count + 1, revision) : [];
      if (generation !== this.refreshGeneration) {
        return;
      }
      this.repository = git;
      this.uncommitted = changes;
      this.revision = revision;
      this.more = commits.length > count;
      this.commits = commits.slice(0, count);
      if (previousRoot !== git?.root) {
        this.repositoryChanged.fire();
      }
      this.historyChanged.fire();
      this.rerender();
    } finally {
      if (generation === this.refreshGeneration) {
        this.refreshing = false;
      }
    }
  }
  async refreshUncommitted(target: FileTarget): Promise<FileTarget | undefined> {
    if (!target.uncommitted) {
      return target;
    }
    const generation = this.refreshGeneration;
    let changes: UncommittedChanges;
    try {
      changes = await this.captureUncommitted(this.access.client(target.repo));
    } catch (error) {
      showError(error);
      return undefined;
    }
    if (
      target.repo === this.selected?.root &&
      target.repo === this.git?.root &&
      generation === this.refreshGeneration
    ) {
      this.uncommitted = changes;
      this.rerender();
    }
    const change = changes[target.uncommitted.kind];
    const file = change.files.find((file) => file.path === target.file.path);
    if (!file) {
      showStatus('選択したファイルには未コミットの変更がなくなりました');
      return undefined;
    }
    const uncommitted = this.snapshot(changes, change);
    return {
      repo: target.repo,
      commit: canonicalCommit(change.commit, change.parent, undefined, uncommitted),
      parent: change.parent,
      file,
      uncommitted,
    };
  }
  private snapshot(changes: UncommittedChanges, change: UncommittedChange): UncommittedSnapshot {
    return {
      kind: change.kind,
      ...(changes.head === undefined ? {} : { head: changes.head }),
      createdAt: changes.createdAt,
    };
  }
  async loadMore(): Promise<void> {
    const git = this.git;
    if (!git || !this.revision || this.loading || this.refreshing) {
      this.rerender();
      return;
    }
    this.loading = true;
    const generation = this.pageGeneration;
    try {
      const commits = await git.log(this.commits.length, COMMIT_PAGE_SIZE + 1, this.revision);
      if (generation !== this.pageGeneration) {
        return;
      }
      this.more = commits.length > COMMIT_PAGE_SIZE;
      this.commits.push(...commits.slice(0, COMMIT_PAGE_SIZE));
    } finally {
      if (generation === this.pageGeneration) {
        this.loading = false;
        this.rerender();
      }
    }
  }
  getTreeItem(node: CommitNode): vscode.TreeItem {
    if (node.kind === 'uncommitted' || node.kind === 'uncommittedGroup') {
      const item = new vscode.TreeItem(
        node.kind === 'uncommitted' ? UNCOMMITTED_LABEL : UNCOMMITTED_KIND_LABELS[node.change.kind],
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = JSON.stringify([node.repo, node.kind, node.kind === 'uncommittedGroup' ? node.change.kind : undefined]);
      item.contextValue = node.kind;
      return item;
    }
    if (node.kind === 'more') {
      const item = new vscode.TreeItem('さらに読み込む');
      item.command = { command: 'vsreview.loadMore', title: 'さらに読み込む' };
      return item;
    }
    if (node.kind === 'commit') {
      const item = new vscode.TreeItem(
        `${shortHash(node.commit.hash)} ${node.commit.subject}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = commitKey({ repoRoot: node.repo, commit: node.commit.hash });
      item.contextValue = 'commit';
      item.description = `${node.commit.author} · ${relativeDate(node.commit.date)}`;
      item.tooltip = `${node.commit.hash}\n${node.commit.author} · ${node.commit.date}\n\n${node.commit.message}`;
      item.iconPath = new vscode.ThemeIcon('git-commit');
      return item;
    }
    return this.files.getTreeItem(node);
  }
  async getChildren(node?: CommitNode): Promise<CommitNode[]> {
    if (!node) {
      const git = this.git;
      return git
        ? [
            ...(this.uncommitted && (this.uncommitted.staged.files.length || this.uncommitted.unstaged.files.length)
              ? [{ kind: 'uncommitted' as const, repo: git.root, changes: this.uncommitted }]
              : []),
            ...this.commits.map((commit) => ({ kind: 'commit' as const, repo: git.root, commit })),
            ...(this.more ? [{ kind: 'more' as const }] : []),
          ]
        : [];
    }
    if (node.kind === 'uncommitted') {
      return node.repo === this.git?.root && node.changes === this.uncommitted
        ? [node.changes.staged, node.changes.unstaged]
            .filter((change) => change.files.length)
            .map((change) => ({
              kind: 'uncommittedGroup',
              repo: node.repo,
              change,
              uncommitted: this.snapshot(node.changes, change),
            }))
        : [];
    }
    if (node.kind === 'uncommittedGroup') {
      if (node.repo !== this.git?.root || this.uncommitted?.[node.change.kind] !== node.change) {
        return [];
      }
      return this.files.fileNodes(displayedFileTree(node.change.files, node.repo), {
        repo: node.repo,
        parent: node.change.parent,
        uncommitted: node.uncommitted,
        commit: canonicalCommit(node.change.commit, node.change.parent, undefined, node.uncommitted),
      });
    }
    if (
      (node.kind !== 'commit' && node.kind !== 'folder') ||
      node.repo !== this.git?.root ||
      !(node.kind === 'folder' && node.uncommitted
        ? this.uncommitted?.[node.uncommitted.kind].commit.hash === node.commit.hash
        : this.commits.some((c) => c.hash === node.commit.hash))
    ) {
      return [];
    }
    if (node.kind === 'folder') {
      return this.files.fileNodes(node.folder.children, node);
    }
    try {
      const git = this.access.client(node.repo);
      const parent = await git.parent(node.commit);
      const files = await this.changedFiles.get(node.repo, node.commit);
      return this.files.fileNodes(displayedFileTree(files, node.repo), { ...node, parent });
    } catch (error) {
      await showRepositoryError(this.access, node.repo, node.commit.hash, error);
      return [];
    }
  }
  dispose(): void {
    this.treeDataChanged.dispose();
    this.repositoryChanged.dispose();
    this.historyChanged.dispose();
  }
}
export type CommentNode =
  | { kind: 'group'; label: string; comments: ReviewComment[] }
  | { kind: 'uncommittedGroup'; label: string; comments: ReviewComment[] }
  | { kind: 'uncommittedSnapshot'; label: string; hash: string; comments: ReviewComment[] }
  | { kind: 'file'; label: string; comments: ReviewComment[] }
  | { kind: 'comment'; comment: ReviewComment };
export function commentContextValue(node: Exclude<CommentNode, { kind: 'comment' }>) {
  if (node.kind === 'file') {
    return 'commentFile';
  }
  if (node.kind === 'uncommittedSnapshot') {
    return 'commentUncommittedSnapshot';
  }
  if (node.kind === 'uncommittedGroup' || node.comments.some((c) => c.uncommitted)) {
    return 'commentUncommittedGroup';
  }
  return node.comments[0]?.pullRequest ? 'commentPullRequestGroup' : 'commentCommitGroup';
}
export class CommentsTree implements vscode.TreeDataProvider<CommentNode>, vscode.Disposable {
  private readonly treeDataChanged = new vscode.EventEmitter<CommentNode | undefined>();
  readonly onDidChangeTreeData = this.treeDataChanged.event;
  private readonly rewrittenSubscription: vscode.Disposable;
  constructor(
    private readonly comments: () => readonly ReviewComment[],
    private readonly rewritten: RewrittenComments,
  ) {
    this.rewrittenSubscription = rewritten.onDidChange(() => this.rerender());
  }

  rerender(): void {
    this.treeDataChanged.fire(undefined);
  }
  getTreeItem(node: CommentNode): vscode.TreeItem {
    if (node.kind !== 'comment') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = commentContextValue(node);
      const changed = node.comments.some((c) => this.rewritten.has(c));
      const suffix = node.comments.some((c) => c.uncommitted)
        ? uncommittedChangedSuffix(changed)
        : rewrittenSuffix(changed);
      item.description = `${commentCountLabel(node.comments.length)}${suffix}`;
      if (node.kind === 'uncommittedSnapshot') {
        item.description = `${shortHash(node.hash)} · ${item.description}`;
        item.tooltip = node.hash;
      }
      return item;
    }
    const c = node.comment;
    const item = new vscode.TreeItem(c.body.split(/\r?\n/).find((line) => line.trim()) ?? 'コメント');
    item.description = `${locationLabel(c)}${c.uncommitted ? uncommittedChangedSuffix(this.rewritten.has(c)) : rewrittenSuffix(this.rewritten.has(c))}`;
    item.tooltip = c.uncommitted && c.side !== 'file' ? `${c.body}\n\n${commentExcerpt(c)}` : c.body;
    item.contextValue = 'comment';
    item.iconPath = new vscode.ThemeIcon(c.resolved ? 'pass' : 'comment');
    item.command = { command: 'vsreview.openComment', title: '差分を開く', arguments: [c] };
    return item;
  }
  getChildren(node?: CommentNode): CommentNode[] {
    if (!node) {
      // エクスポートでも使う reviewGroupKey の意味を変えず、このツリーだけ区分でまとめる。
      return [
        ...groupBy(this.comments(), (c) =>
          c.uncommitted ? JSON.stringify([c.repoRoot, 'uncommitted', c.uncommitted.kind]) : reviewGroupKey(c),
        ).values(),
      ].map((comments) => {
        const first = comments[0];
        return {
          kind: first?.uncommitted ? 'uncommittedGroup' : 'group',
          label: first
            ? first.pullRequest
              ? `${basename(first.repoRoot)} · PR #${first.pullRequest.number} ${replaceDisplayControls(first.pullRequest.title)}`
              : first.uncommitted
                ? `${basename(first.repoRoot)} · ${uncommittedLabel(first.uncommitted.kind)}`
                : `${basename(first.repoRoot)} · ${shortHash(first.commit)} ${first.subject}`
            : '',
          comments,
        };
      });
    }
    if (node.kind === 'uncommittedGroup') {
      return [...groupBy(node.comments, commitKey).values()].flatMap((comments) => {
        const first = comments[0];
        if (!first) {
          return [];
        }
        const dates = comments.flatMap((c) =>
          c.uncommitted && Number.isFinite(Date.parse(c.uncommitted.createdAt)) ? [c.uncommitted.createdAt] : [],
        );
        dates.sort((a, b) => Date.parse(a) - Date.parse(b));
        return [
          {
            kind: 'uncommittedSnapshot' as const,
            hash: first.commit,
            label: snapshotDateLabel(dates[0] ?? ''),
            comments,
          },
        ];
      });
    }
    if (node.kind === 'group' || node.kind === 'uncommittedSnapshot') {
      return [...groupBy(node.comments, (c) => c.path)].map(([label, comments]) => ({ kind: 'file', label, comments }));
    }
    if (node.kind === 'file') {
      return node.comments.map((comment) => ({ kind: 'comment', comment }));
    }
    return [];
  }
  dispose(): void {
    this.rewrittenSubscription.dispose();
    this.treeDataChanged.dispose();
  }
}
