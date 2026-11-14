import type { RevisionArchives } from './revisionArchives';
import type { PullRequestSource } from '../git/gh';
import { restorePullRequestComparison } from '../git/pullRequests';
import type { PullRequestReviews } from './pullRequestReviews';
import { fileSide } from '../core/gitParsing';
import * as vscode from 'vscode';
import { orderedFiles } from './fileView';
import { commentRange } from './ranges';
import type { ReviewComment } from '../core/model';
import type { FileTarget } from '../core/documents';
import { shortHash, uncommittedLabel } from '../core/presentation';
import type { ReviewDocuments } from './documents';
import { ChangedFiles, type RepositoryAccess } from './repositories';
import { showInfo, showStatus } from './common';
export class ReviewDiff {
  constructor(
    private readonly documents: ReviewDocuments,
    private readonly access: RepositoryAccess,
    private readonly changedFiles: ChangedFiles,
    private readonly source: PullRequestSource,
    private readonly pullRequestReviews: Pick<PullRequestReviews, 'review'>,
    private readonly archives: Pick<RevisionArchives, 'withLease'>,
  ) {}
  async openDiff(target: FileTarget, comment?: ReviewComment): Promise<void> {
    const show = () => this.showDiff(target, comment);
    await this.archives.withLease(show);
  }
  private async showDiff(target: FileTarget, comment?: ReviewComment): Promise<void> {
    const git = this.access.client(target.repo);
    if (target.uncommitted) {
      // HEAD のない staged の親は空ツリーなので、コミットの存在確認から除く。
      const checkParent = target.uncommitted.kind === 'unstaged' || target.uncommitted.head !== undefined;
      if (!(await git.hasCommit(target.commit.hash)) || (checkParent && !(await git.hasCommit(target.parent)))) {
        showInfo('保存したスナップショットのオブジェクトが見つからないため、差分を開けません');
        return;
      }
    }
    if (target.pullRequest) {
      await restorePullRequestComparison(
        git,
        target.pullRequest,
        this.source.remote(),
        this.source.gh(git.root),
        comment?.pullRequest ?? this.pullRequestReviews.review(target),
      );
    }
    const old = fileSide(target.file, 'old');
    const next = fileSide(target.file, 'new');
    if (
      (!old.empty && (await git.isGitlink(target.parent, old.path))) ||
      (!next.empty && (await git.isGitlink(target.commit.hash, next.path)))
    ) {
      showInfo('サブモジュールの差分は表示できません');
      return;
    }
    const oldContent = old.empty ? undefined : await git.content(target.parent, old.path);
    const newContent = next.empty ? undefined : await git.content(target.commit.hash, next.path);
    if (oldContent?.binary || newContent?.binary) {
      showInfo('バイナリファイルの差分は表示できません');
      return;
    }
    const { left, right } = await this.documents.diffUris(target);
    const selectedUri = comment?.side === 'old' ? left : right;
    const selectedDoc =
      comment && comment.side !== 'file' ? await vscode.workspace.openTextDocument(selectedUri) : undefined;
    const range = comment && selectedDoc ? commentRange(comment, selectedDoc) : undefined;
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${target.file.path} (${target.uncommitted ? uncommittedLabel(target.uncommitted.kind) : shortHash(target.commit.hash)})`,
      { preview: true, ...(range && comment?.side === 'new' ? { selection: range } : {}) },
    );
    if (range && comment) {
      await vscode.commands.executeCommand(
        comment.side === 'old'
          ? 'workbench.action.compareEditor.focusSecondarySide'
          : 'workbench.action.compareEditor.focusPrimarySide',
      );
      const editor = vscode.window.activeTextEditor;
      if (editor?.document.uri.toString() === selectedUri.toString()) {
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    }
  }
  async openAdjacentDiff(offset: number, argument: unknown): Promise<void> {
    const target = await this.documents.targetFrom(argument);
    if (!target) {
      return;
    }
    const files = orderedFiles(await this.changedFiles.get(target.repo, target.commit), target.repo);
    const index = files.findIndex((file) => file.path === target.file.path);
    const file = index >= 0 ? files[index + offset] : undefined;
    if (file) {
      await this.openDiff({ ...target, file });
    } else {
      showStatus('この方向にファイルはありません');
    }
  }
}
