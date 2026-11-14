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
} from '../core/presentation';
import type { RewrittenComments } from './rewritten';

export const COMMIT_PAGE_SIZE = 50;

export type CommitNode = { kind: 'commit'; repo: string; commit: Commit } | ChangedFileNode | { kind: 'more' };
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
  constructor(
    comments: () => readonly ReviewComment[],
    private readonly access: RepositoryAccess,
    private readonly changedFiles: ChangedFiles,
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
      if (previousRoot === git?.root && revision === this.revision) {
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
            ...this.commits.map((commit) => ({ kind: 'commit' as const, repo: git.root, commit })),
            ...(this.more ? [{ kind: 'more' as const }] : []),
          ]
        : [];
    }
    if (
      (node.kind !== 'commit' && node.kind !== 'folder') ||
      node.repo !== this.git?.root ||
      !this.commits.some((c) => c.hash === node.commit.hash)
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
  | { kind: 'file'; label: string; comments: ReviewComment[] }
  | { kind: 'comment'; comment: ReviewComment };
export function commentContextValue(node: Exclude<CommentNode, { kind: 'comment' }>) {
  if (node.kind === 'file') {
    return 'commentFile';
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
      item.description = `${commentCountLabel(node.comments.length)}${rewrittenSuffix(node.comments.some((c) => this.rewritten.has(c)))}`;
      return item;
    }
    const c = node.comment;
    const item = new vscode.TreeItem(c.body.split(/\r?\n/).find((line) => line.trim()) ?? 'コメント');
    item.description = `${locationLabel(c)}${rewrittenSuffix(this.rewritten.has(c))}`;
    item.tooltip = c.body;
    item.contextValue = 'comment';
    item.iconPath = new vscode.ThemeIcon(c.resolved ? 'pass' : 'comment');
    item.command = { command: 'vsreview.openComment', title: '差分を開く', arguments: [c] };
    return item;
  }
  getChildren(node?: CommentNode): CommentNode[] {
    if (!node) {
      return [...groupBy(this.comments(), reviewGroupKey).values()].map((comments) => {
        const first = comments[0];
        return {
          kind: 'group',
          label: first
            ? first.pullRequest
              ? `${basename(first.repoRoot)} · PR #${first.pullRequest.number} ${replaceDisplayControls(first.pullRequest.title)}`
              : `${basename(first.repoRoot)} · ${shortHash(first.commit)} ${first.subject}`
            : '',
          comments,
        };
      });
    }
    if (node.kind === 'group') {
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
