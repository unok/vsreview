import type { RevisionArchives } from './revisionArchives';
import { contributes } from '../../package.json';
import type { PullRequestCommands } from './pullRequestCommands';
import type { PullRequestsTree } from './pullRequests';
import type { FilesTree } from './files';
import * as vscode from 'vscode';
import { updateFileView } from './fileView';
import { isRecord } from '../core/validation';
import { isCommit } from '../core/gitParsing';
import { targetFromComment } from '../core/documents';
import type { ReviewComments } from './comments';
import type { ReviewDocuments } from './documents';
import type { ReviewDiff } from './diff';
import type { RepositoryAccess } from './repositories';
import { commentContextValue, type CommentNode, type CommitsTree } from './trees';
import { comparisonKey, commitKey } from '../core/comparisons';
import { isReviewComment, isCommentPurpose, type ReviewComment } from '../core/model';
import type { RewrittenComments } from './rewritten';
import { basename } from 'node:path';
import { registerCommand, showError, showInfo, showStatus } from './common';
import { isExportRequest, exportComments } from './export';
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
  },
): void {
  const { documents, filesTree, diff, comments, commitsTree, rewritten, access } = app;
  const command = (name: string, fn: (...args: unknown[]) => unknown): void => registerCommand(context, name, fn);
  command('clearRevisionArchives', () => app.archives.clear());
  command('resetRevisionArchivePermissions', () => app.archives.resetPermissions());
  command('openRevisionFile', (arg) => filesTree.open(arg));
  command('showFileTree', () => updateFileView('tree', commitsTree.git?.root));
  command('showFileList', () => updateFileView('list', commitsTree.git?.root));
  command('refresh', () => updateRepository(app));
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
  command('addRangeComment', (arg) => comments.addRangeComment(arg));
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
      // 描画後に同じ比較へ追加されたコメントも含めるため、ノードの ID 一覧ではなく比較とパスで照合する。
      const keys = new Set(arg.comments.map(reviewComparisonKey));
      const path = arg.kind === 'file' ? arg.label : undefined;
      return comments.clearMatching(
        (comment) => keys.has(reviewComparisonKey(comment)) && (path === undefined || comment.path === path),
        scope,
      );
    });
  }
  command('clearRewrittenComments', async () => {
    await rewritten.refresh();
    await comments.clearRewritten(rewritten.has);
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
  return comment.pullRequest ? comparisonKey(comment) : commitKey(comment);
}
