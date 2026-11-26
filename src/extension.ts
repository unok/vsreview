import { SerialQueue } from './core/collections';
import type { DocumentRef } from './core/documents';
import { RevisionSnapshots } from './ui/revisionSnapshots';
import { RevisionArchives } from './ui/revisionArchives';
import { PullRequestCommands } from './ui/pullRequestCommands';
import { PullRequestReviews } from './ui/pullRequestReviews';
import { pullRequestRemoteSetting } from './ui/pullRequestSettings';
import { GhClient } from './git/gh';
import { PullRequestsTree } from './ui/pullRequests';
import * as vscode from 'vscode';
import { StatusDecorationProvider } from './ui/decorations';
import { FilesTree } from './ui/files';
import { fileView } from './ui/fileView';
import { GitClient } from './git/client';
import { ReviewComments } from './ui/comments';
import { CommitsTree, CommentsTree } from './ui/trees';
import { ReviewDocuments } from './ui/documents';
import { ReviewDiff } from './ui/diff';
import { RepositoryAccess, ChangedFiles } from './ui/repositories';
import { RevisionProvider } from './ui/revisions';
import { RewrittenComments, rewrittenTargets } from './ui/rewritten';
import { registerReviewCommands, updateRepository } from './ui/commands';
import { registerNavigation } from './ui/navigation';
import { AutoRefresh } from './ui/autoRefresh';
import { showError } from './ui/common';
import { ExplanationStore } from './git/explanationStore';
import { captureUncommittedChanges } from './git/uncommitted';
import type { CommitTarget } from './core/documents';
import { ExplanationPermissions } from './ui/explanationPermissions';
import { ReviewExplanations } from './ui/explanations';
import { ExplanationCommands, registerExplanationCommands } from './ui/explanationCommands';
export interface ReviewApi {
  commentsTree: CommentsTree;
  commitsTree: CommitsTree;
  pullRequestsTree: PullRequestsTree;
  comments: ReviewComments;
  filesTree: FilesTree;
  readonly resolveDocumentRef: (uri: vscode.Uri) => Promise<DocumentRef | undefined>;
  readonly provideFileDecoration: StatusDecorationProvider['provideFileDecoration'];
}
export async function activate(context: vscode.ExtensionContext): Promise<ReviewApi | undefined> {
  const access = new RepositoryAccess((repo) => new GitClient(repo));
  // 復元タブの初回の内容要求を解決するため、プロバイダ登録前に許可ルートを確定する。
  await access.discover();
  const changedFiles = new ChangedFiles(access);
  const snapshots = new RevisionSnapshots(access, changedFiles);
  const archives = RevisionArchives.create(context, access, snapshots);
  const documents = new ReviewDocuments(access, archives);
  const source = { gh: (repo: string) => new GhClient(repo), remote: pullRequestRemoteSetting };
  let comments: ReviewComments;
  const pullRequestReviews = new PullRequestReviews(
    () => comments.all,
    () => documents.openDiffRefs(),
    source,
  );
  try {
    comments = new ReviewComments(
      context.workspaceState,
      () => {
        commitsTree.rerender();
        pullRequestsTree.rerender();
        // 新規コメントの到達判定を更新し、その通知で CommentsTree も再描画する。
        void rewritten.refresh().catch(showError);
      },
      documents,
      access,
      pullRequestReviews,
    );
  } catch (error) {
    pullRequestReviews.dispose();
    showError(error);
    return;
  }
  const explanationPermissions = new ExplanationPermissions(context.workspaceState);
  const explanations = new ReviewExplanations({
    access,
    // 保存領域がない場合はメモリだけで持つ。
    store: new ExplanationStore(context.storageUri?.scheme === 'file' ? context.storageUri.fsPath : undefined),
    permissions: explanationPermissions,
  });
  const explained = (target: CommitTarget, path: string): boolean => explanations.explained(target, path);
  const commitsTree = new CommitsTree(() => comments.all, access, changedFiles, captureUncommittedChanges, explained);
  const pullRequestsTree = PullRequestsTree.register(commitsTree, changedFiles, {
    comments: () => comments.all,
    reviews: pullRequestReviews,
    source,
    explained,
  });
  const rewritten = new RewrittenComments(() => rewrittenTargets(comments.all, documents), access, pullRequestReviews);
  const commentsTree = new CommentsTree(() => comments.all, rewritten);
  const diff = new ReviewDiff(documents, access, changedFiles, source, pullRequestReviews, archives);
  const filesTree = FilesTree.register(documents, access, snapshots, archives);
  const autoRefresh = new AutoRefresh(access, commitsTree, rewritten, documents);
  const app = {
    archives,
    documents,
    filesTree,
    diff,
    comments,
    commitsTree,
    pullRequestsTree,
    pullRequestCommands: new PullRequestCommands(pullRequestsTree, changedFiles, source, pullRequestReviews),
    rewritten,
    access,
    rewatch: () => autoRefresh.rewatch({ refresh: false }),
    explanations,
  };
  const statusDecorations = new StatusDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(statusDecorations),
    autoRefresh,
    rewritten,
    comments,
    commitsTree,
    pullRequestsTree,
    pullRequestReviews,
    commentsTree,
    pullRequestReviews.onDidChangeHeads(() => {
      void rewritten.refresh().catch(showError);
    }),
    filesTree,
    explanations,
    // 解説の生成・保存・読み込みで「解説あり」の表示を更新する。
    explanations.onDidChange(() => {
      commitsTree.rerender();
      pullRequestsTree.rerender();
    }),
    // 起動時の最初の選択もリポジトリの変更として届く。
    commitsTree.onDidChangeRepository(() => {
      const root = commitsTree.git?.root;
      if (root) {
        void explanations.load(root).catch(showError);
      }
    }),
    commitsTree.onDidChangeHistory(() => {
      void filesTree.synchronize({ refresh: true }).catch(showError);
    }),
    vscode.window.createTreeView('vsreview.commits', { treeDataProvider: commitsTree }),
    vscode.window.createTreeView('vsreview.comments', { treeDataProvider: commentsTree }),
    vscode.workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateRepository(app, { select: true, preserveSelection: true }).catch(showError);
    }),
  );
  const editorQueue = new SerialQueue();
  let synchronization: Promise<void> | undefined;
  let synchronizationRequested = false;
  const synchronizeEditors = (): Promise<void> => {
    synchronizationRequested = true;
    return (synchronization ??= editorQueue
      .run(async () => {
        while (synchronizationRequested) {
          synchronizationRequested = false;
          const diffs = await documents.openDiffs();
          documents.recordActiveDiff(diffs);
          void archives.prune().catch((error: unknown) => archives.reportFailure(error));
          await filesTree.synchronize({ diffs });
          await comments.refresh({ diffs });
          const editor = vscode.window.activeTextEditor;
          await vscode.commands.executeCommand(
            'setContext',
            'vsreview.isReviewDocument',
            Boolean(editor && (await documents.resolve(editor.document.uri, { diffs }))),
          );
        }
      })
      .finally(() => {
        synchronization = undefined;
      })
      .catch(showError));
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(synchronizeEditors),
    vscode.window.tabGroups.onDidChangeTabGroups(synchronizeEditors),
    vscode.window.tabGroups.onDidChangeTabs(synchronizeEditors),
    vscode.workspace.onDidChangeTextDocument((event) => {
      return (async () => {
        await archives.warnIfEdited(event);
        await comments.refreshDocument(event.document);
      })().catch(showError);
    }),
  );
  const synchronizeFileView = (): void => {
    void vscode.commands.executeCommand('setContext', 'vsreview.fileView', fileView(commitsTree.git?.root));
    commitsTree.rerender();
    pullRequestsTree.rerender();
  };
  synchronizeFileView();
  context.subscriptions.push(
    commitsTree.onDidChangeRepository(synchronizeFileView),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('vsreview.fileView') || event.affectsConfiguration('explorer.compactFolders')) {
        synchronizeFileView();
      }
      if (event.affectsConfiguration('vsreview.pullRequests')) {
        void pullRequestsTree.reload().catch(showError);
      }
      if (event.affectsConfiguration('vsreview.autoRefresh')) {
        void autoRefresh.rewatch().catch(showError);
      }
    }),
  );
  registerNavigation(context, documents, access);
  registerReviewCommands(context, app);
  registerExplanationCommands(
    context,
    new ExplanationCommands({ access, changedFiles, commitsTree, pullRequestsTree, explanations }),
    explanationPermissions,
  );
  void updateRepository(app, { select: true, discover: false }).then(synchronizeEditors).catch(showError);
  void synchronizeEditors();
  return {
    commentsTree,
    commitsTree,
    pullRequestsTree,
    comments,
    filesTree,
    resolveDocumentRef: (uri) => documents.resolve(uri),
    provideFileDecoration: (uri) => statusDecorations.provideFileDecoration(uri),
  };
}
