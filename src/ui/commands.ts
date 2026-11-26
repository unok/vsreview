import type { RevisionArchives } from './revisionArchives';
import { contributes } from '../../package.json';
import type { PullRequestCommands } from './pullRequestCommands';
import type { PullRequestsTree } from './pullRequests';
import type { FilesTree } from './files';
import * as vscode from 'vscode';
import { updateFileView } from './fileView';
import { isRecord, isRevision } from '../core/validation';
import { isCommit } from '../core/gitParsing';
import { targetFromComment } from '../core/documents';
import type { ReviewComments } from './comments';
import type { ReviewDocuments } from './documents';
import type { ReviewDiff } from './diff';
import type { RepositoryAccess } from './repositories';
import { commentContextValue, type CommentNode, type CommitsTree } from './trees';
import { comparisonKey, commitKey, commentGroupKey } from '../core/comparisons';
import { isReviewComment, isCommentPurpose, selectComments, type ReviewComment } from '../core/model';
import type { RewrittenComments } from './rewritten';
import type { ReviewExplanations } from './explanations';
import { basename } from 'node:path';
import { registerCommand, showError, showInfo, showStatus } from './common';
import { isExportRequest, exportComments, copyInstructions } from './export';
import { workingPosition } from './navigation';
export async function selectRepository(
  access: RepositoryAccess,
  commitsTree: CommitsTree,
  options: { preserveSelection?: boolean; discover?: boolean } = {},
): Promise<void> {
  if (options.discover !== false) {
    await access.discover();
  }
  if (commitsTree.git && !access.isKnown(commitsTree.git.root)) {
    await commitsTree.select(undefined);
  }
  if (options.preserveSelection && commitsTree.git && access.isKnown(commitsTree.git.root)) {
    await commitsTree.reload();
    return;
  }
  const roots = access.all();
  if (!roots.length) {
    await commitsTree.select(undefined);
    showInfo('ワークスペースに Git リポジトリがありません');
    return;
  }
  const root =
    roots.length === 1
      ? roots[0]
      : (
          await vscode.window.showQuickPick(
            roots.map((root) => ({ label: basename(root), description: root, root })),
            { title: 'リポジトリを選択' },
          )
        )?.root;
  if (root && access.isKnown(root)) {
    await commitsTree.select(access.client(root));
  }
}
interface RepositoryUpdate {
  access: RepositoryAccess;
  commitsTree: CommitsTree;
  rewritten: RewrittenComments;
  comments: ReviewComments;
  pullRequestsTree: PullRequestsTree;
  rewatch?: () => Promise<void>;
}
export async function updateRepository(
  app: RepositoryUpdate,
  options: { select?: boolean; preserveSelection?: boolean; discover?: boolean } = {},
): Promise<void> {
  if (options.select || !app.commitsTree.git || !app.access.isKnown(app.commitsTree.git.root)) {
    await selectRepository(app.access, app.commitsTree, options);
  } else {
    await app.commitsTree.reload();
  }
  void app.pullRequestsTree.reload().catch(showError);
  await app.rewritten.refresh();
  await app.comments.refresh();
  await app.rewatch?.();
}
export function registerReviewCommands(
  context: vscode.ExtensionContext,
  app: {
    archives: RevisionArchives;
    filesTree: FilesTree;
    documents: ReviewDocuments;
    diff: ReviewDiff;
    comments: ReviewComments;
    commitsTree: CommitsTree;
    rewritten: RewrittenComments;
    access: RepositoryAccess;
    pullRequestsTree: PullRequestsTree;
    pullRequestCommands: PullRequestCommands;
    rewatch?: () => Promise<void>;
    explanations?: Pick<ReviewExplanations, 'load'>;
  },
): void {
  const { documents, filesTree, diff, comments, commitsTree, rewritten, access } = app;
  const command = (name: string, fn: (...args: unknown[]) => unknown): void => registerCommand(context, name, fn);
  command('clearRevisionArchives', () => app.archives.clear());
  command('resetRevisionArchivePermissions', () => app.archives.resetPermissions());
  command('openRevisionFile', (arg) => filesTree.open(arg));
  command('showFileTree', () => updateFileView('tree', commitsTree.git?.root));
  command('showFileList', () => updateFileView('list', commitsTree.git?.root));
  command('refresh', async () => {
    await updateRepository(app);
    // 一時的な失敗の後も、手動の更新で解説の索引と失敗の記録を読み直す。
    const root = commitsTree.git?.root;
    if (root) {
      await app.explanations?.load(root);
    }
  });
  command('selectRepository', () => updateRepository(app, { select: true }));
  command('refreshPullRequests', () => app.pullRequestsTree.reload());
  command('openPullRequest', (node) => app.pullRequestCommands.open(node, diff));
  command('openPullRequestNumber', () => app.pullRequestCommands.openNumber(diff));
  command('loadMore', () => commitsTree.loadMore());
  command('copyHash', (arg) => {
    if (isRecord(arg) && typeof arg.repo === 'string' && access.isKnown(arg.repo) && isCommit(arg.commit)) {
      return vscode.env.clipboard.writeText(arg.commit.hash);
    }
  });
  command('openDiff', async (arg) => {
    const resolved = await documents.targetFrom(arg);
    // ツリー選択では選択時の内容を固定し、URI の再表示では元のスナップショットを保つ。
    const target =
      isRecord(arg) && arg.kind === 'file' && resolved?.uncommitted
        ? await commitsTree.refreshUncommitted(resolved)
        : resolved;
    if (target) {
      await diff.openDiff(target);
      await comments.refresh();
    }
  });
  command('nextFile', (arg) => diff.openAdjacentDiff(1, arg));
  command('previousFile', (arg) => diff.openAdjacentDiff(-1, arg));
  command('addFileComment', async (arg) => {
    const resolved = await documents.fileCommentTargetFrom(arg);
    if (resolved) {
      // 差分を開かずツリーからコメントする場合も、選択時の内容へ結び付ける。
      const target =
        isRecord(arg) && arg.kind === 'file' && resolved.target.uncommitted
          ? await commitsTree.refreshUncommitted(resolved.target)
          : resolved.target;
      if (target) {
        await comments.addFileComment(target, resolved.document);
      }
    }
  });
  command('openWorkingFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const target = await workingPosition(editor.document, editor.selection.active, documents, access);
    if ('reason' in target) {
      showStatus(target.reason);
      return;
    }
    await vscode.window.showTextDocument(target.uri, {
      selection: new vscode.Range(target.position, target.position),
    });
  });
  command('addRangeComment', (arg) => comments.addRangeComment(arg, 'fix'));
  command('addRangeQuestion', (arg) => comments.addRangeComment(arg, 'question'));
  command('editComment', (arg) => comments.edit(arg));
  command('saveComment', (arg) => comments.save(arg));
  command('cancelEdit', (arg) => comments.cancelEdit(arg));
  command('deleteComment', (arg) => comments.delete(arg));
  command('toggleResolved', (arg) => comments.toggle(arg));
  command('togglePurpose', (arg) => comments.togglePurpose(arg));
  command('clearComments', () => comments.clear());
  for (const [name, contextValue] of [
    ['clearCommitComments', 'commentCommitGroup'],
    ['clearPullRequestComments', 'commentPullRequestGroup'],
    ['clearFileComments', 'commentFile'],
  ] as const) {
    // メニューと確認文の対象表記は、マニフェストのタイトルを共通の出所にする。
    const title = contributes.commands.find((entry) => entry.command === `vsreview.${name}`)!.title;
    const scope = title.slice('VSReview: '.length, -'コメントを削除'.length);
    command(name, (arg) => {
      if (!isCommentGroupOrFileNode(arg) || commentContextValue(arg) !== contextValue) {
        return;
      }
      return comments.clearMatching(commentNodeFilter(arg), scope);
    });
  }
  command('clearRewrittenComments', async () => {
    await rewritten.refresh();
    await comments.clearRewritten(rewritten.has);
  });
  command('copyInstructions', (arg) => {
    if (!isCopyInstructionsNode(arg)) {
      return;
    }
    const selected = selectComments(commentsForNode(arg, comments.all), { unresolvedOnly: true });
    return copyInstructions(selected, access, rewritten.has);
  });
  command('exportComments', (arg) => {
    // view/title は { $treeViewId } を渡すため、出力指定のないオブジェクトも対話に進める。
    const request = isExportRequest(arg) ? arg : undefined;
    const purpose = request ? request.purpose : isRecord(arg) ? arg.purpose : undefined;
    if ((purpose !== undefined && !isCommentPurpose(purpose)) || (!request && !hasNoExportSpec(arg))) {
      throw new Error('エクスポートの出力指定が不正です');
    }
    return exportComments(comments.all, access, {
      currentRepo: commitsTree.git?.root,
      request: request ?? (purpose === undefined ? undefined : { purpose }),
      rewritten: rewritten.has,
    });
  });
  command('openComment', (arg) => {
    const comment = comments.all.find((c) => c.id === comments.id(arg));
    if (comment && access.isKnown(comment.repoRoot)) {
      return diff.openDiff(targetFromComment(comment), comment);
    }
  });
}

function hasNoExportSpec(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      !('scope' in value) &&
      !('format' in value))
  );
}

function isCommentGroupOrFileNode(value: unknown): value is Exclude<CommentNode, { kind: 'comment' }> {
  return (
    isRecord(value) &&
    (value.kind === 'group' || value.kind === 'file') &&
    typeof value.label === 'string' &&
    Array.isArray(value.comments) &&
    value.comments.every(isReviewComment)
  );
}
function reviewComparisonKey(comment: ReviewComment): string {
  // PR は複数の比較を含むので reviewGroupKey では広すぎる。comparisonKey で同じコミットの通常レビューとも区別する。
  // 通常レビューは親の有無にかかわらず、既存のグループ分けと同じコミット単位で扱う。
  // 同じハッシュを持つ未コミットのスナップショットと通常レビューを分けるため、表示区分も含める。
  return JSON.stringify([commentGroupKey(comment), comment.pullRequest ? comparisonKey(comment) : commitKey(comment)]);
}

function isCopyInstructionsNode(value: unknown): value is CommentNode {
  if (!isRecord(value) || Array.isArray(value)) {
    return false;
  }
  if (value.kind === 'comment') {
    return isReviewComment(value.comment);
  }
  return (
    (value.kind === 'group' ||
      value.kind === 'file' ||
      value.kind === 'uncommittedGroup' ||
      (value.kind === 'uncommittedSnapshot' && isRevision(value.hash))) &&
    typeof value.label === 'string' &&
    Array.isArray(value.comments) &&
    // Array.from は疎配列の穴も検証する。
    Array.from(value.comments).every(isReviewComment)
  );
}

function commentsForNode(node: CommentNode, comments: readonly ReviewComment[]): readonly ReviewComment[] {
  if (node.kind === 'comment') {
    return comments.filter((comment) => comment.id === node.comment.id);
  }
  if (node.kind === 'group' || node.kind === 'file') {
    return comments.filter(commentNodeFilter(node));
  }
  const first = node.comments[0];
  if (!first) {
    return [];
  }
  return comments.filter(
    (comment) =>
      comment.repoRoot === first.repoRoot &&
      comment.uncommitted !== undefined &&
      comment.uncommitted.kind === first.uncommitted?.kind &&
      (node.kind !== 'uncommittedSnapshot' || comment.commit === node.hash),
  );
}

function commentNodeFilter(node: Exclude<CommentNode, { kind: 'comment' }>): (comment: ReviewComment) => boolean {
  // ノードの comments は描画時の値なので、表示区分・比較・パスを保存済みコメントへ照合し直し、
  // 同じ比較への描画後の追加・編集・解決状態の変更を反映する。
  const keys = new Set(node.comments.map(reviewComparisonKey));
  const path = node.kind === 'file' ? node.label : undefined;
  return (comment) => keys.has(reviewComparisonKey(comment)) && (path === undefined || comment.path === path);
}
