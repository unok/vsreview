import * as vscode from 'vscode';
import { commentCounts, type ReviewComment } from '../core/model';
import { comparisonKey } from '../core/comparisons';
import type { FileTarget, CommitTarget } from '../core/documents';
import { flattenFileTree, type FileTreeNode } from '../core/fileTree';
import { commentCountLabel } from '../core/presentation';
import { statusLabel, folderStatus } from '../core/decorations';
import { statusUri } from './decorations';
export type ChangedFileNode =
  | ({ kind: 'file'; name: string } & FileTarget)
  | (CommitTarget & { kind: 'folder'; folder: Extract<FileTreeNode, { kind: 'folder' }> });
export class ChangedFileNodes {
  private countedComments: readonly ReviewComment[] | undefined;
  private commentCounts = new Map<string, Map<string, number>>();
  constructor(private readonly comments: () => readonly ReviewComment[]) {}
  private counts(): Map<string, Map<string, number>> {
    // ReviewComments は保存時に配列を置き換えるため、参照が変わるまで件数を再利用できる。
    const comments = this.comments();
    if (this.countedComments !== comments) {
      this.countedComments = comments;
      this.commentCounts = commentCounts(comments);
    }
    return this.commentCounts;
  }
  getTreeItem(node: ChangedFileNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = JSON.stringify([comparisonKey(node), node.kind, node.folder.path]);
      item.contextValue = 'folder';
      item.iconPath = vscode.ThemeIcon.Folder;
      const changes = new Map(flattenFileTree(node.folder.children).map((file) => [file.path, file]));
      const status = folderStatus(node.folder.path, changes);
      item.tooltip = statusLabel(node.folder.path, status);
      item.accessibilityInformation = { label: item.tooltip };
      item.resourceUri = statusUri({
        repo: node.repo,
        commit: node.commit.hash,
        side: 'new',
        kind: 'folder',
        path: node.folder.path,
        status,
      });
      const counts = this.counts().get(comparisonKey(node));
      const count = node.folder.paths.reduce((sum, path) => sum + (counts?.get(path) ?? 0), 0);
      item.description = commentCountLabel(count);
      return item;
    }
    // TreeItemLabel.highlights はテーマ次第で背景色が付き、FileDecoration の状態色を隠すため使わない。
    // 太字だけを指定する API はないので、変更ファイルのラベルは文字列のまま渡す。
    const item = new vscode.TreeItem(node.name);
    item.contextValue = 'file';
    item.id = JSON.stringify([comparisonKey(node), node.kind, node.file.path]);
    item.description = [
      node.file.oldPath,
      commentCountLabel(this.counts().get(comparisonKey(node))?.get(node.file.path) ?? 0),
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = vscode.ThemeIcon.File;
    item.tooltip = statusLabel(node.file.path, node.file.status);
    item.accessibilityInformation = { label: item.tooltip };
    item.resourceUri = statusUri({
      repo: node.repo,
      commit: node.commit.hash,
      side: 'new',
      kind: 'file',
      path: node.file.path,
      status: node.file.status,
    });
    item.command = { command: 'vsreview.openDiff', title: '差分を開く', arguments: [node] };
    return item;
  }
  fileNodes(nodes: readonly FileTreeNode[], target: CommitTarget): ChangedFileNode[] {
    const { repo, commit, parent, pullRequest } = target;
    const comparison = { repo, commit, parent, ...(pullRequest ? { pullRequest } : {}) };
    return nodes.map((node) =>
      node.kind === 'file'
        ? { ...comparison, kind: 'file', name: node.name, file: node.file }
        : { ...comparison, kind: 'folder', folder: node },
    );
  }
}
