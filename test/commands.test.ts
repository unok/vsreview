import {
  revisionArchives,
  archiveLease,
  reviewDocuments,
  revisionSnapshots,
  pullRequestCommandsFor,
  unexpectedGh,
  registerPullRequestsTree,
  disposeAfter,
  waitFor,
  workspaceFolder,
  extensionContext,
  repository,
  accessFor,
  MemoryState,
  reviewComment,
  pullRequestReview,
} from './fixtures';
import { AutoRefresh } from '../src/ui/autoRefresh';
import { serialize, type ReviewComment } from '../src/core/model';
import { GhClient } from '../src/git/gh';
import { ChangedFiles } from '../src/ui/repositories';
import { FilesTree } from '../src/ui/files';
import type * as vscode from 'vscode';
import { targetFromComment } from '../src/core/documents';
import { activate } from '../src/extension';
import { describe, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll } from './gitFixtures';
import { ReviewComments } from '../src/ui/comments';
import { ReviewDiff } from '../src/ui/diff';
import { CommitsTree, CommentsTree, COMMIT_PAGE_SIZE } from '../src/ui/trees';
import { RewrittenComments, rewrittenTargets } from '../src/ui/rewritten';
import { registerReviewCommands, selectRepository, updateRepository } from '../src/ui/commands';
import { registerCommand } from '../src/ui/common';
import { revisionUri, RevisionProvider, documentRef } from '../src/ui/revisions';
import { runGit } from '../src/git/client';
import {
  activateTab,
  TabInputTextDiff,
  TabInputText,
  commands,
  env,
  controller,
  threads,
  docs,
  Range,
  CommentMode,
  textDocument,
  window,
  pick,
  globalConfiguration,
  workspace,
  Uri,
  input,
  watchers,
  warning,
  disposedThreads,
  documentOpened,
} from './vscodeMock';

describe('commands', () => {
  async function uncommittedFixture() {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    await writeFile(join(directory, 'b.ts'), 'base');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'a.ts'), 'ONE\ntwo\nthree\nfour\nfive\n');
    await runGit(directory, ['add', 'a.ts']);
    await writeFile(join(directory, 'a.ts'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
    await writeFile(join(directory, 'b.ts'), 'working');
    workspace.workspaceFolders = [workspaceFolder(directory)];
    globalConfiguration.set('vsreview.autoRefresh', false);
    globalConfiguration.set('vsreview.fileView', 'list');
    const state = new MemoryState();
    const context = extensionContext(state);
    const api = (await activate(context))!;
    await waitFor(async () => expect((await api.commitsTree.getChildren())[0]?.kind).toBe('uncommitted'));
    const groups = await api.commitsTree.getChildren((await api.commitsTree.getChildren())[0]);
    const staged = (await api.commitsTree.getChildren(groups[0]))[0]!;
    const unstaged = (await api.commitsTree.getChildren(groups[1]))[0]!;
    return { directory, git, state, context, api, staged, unstaged };
  }
  it('URIから差分を開き直すと作業ツリー変更後も元のスナップショットを保持する', async () => {
    const { directory, unstaged } = await uncommittedFixture();
    if (unstaged.kind !== 'file') {
      throw new Error('file expected');
    }
    const uri = revisionUri(unstaged, 'new');
    const original = (await workspace.openTextDocument(uri)).getText();
    await writeFile(join(directory, 'a.ts'), 'later content');
    await commands.executeCommand('vsreview.openDiff', uri);
    const call = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
    const right = call[2] as vscode.Uri;
    expect(right.toString()).toBe(uri.toString());
    expect(documentRef(right)?.commit.hash).toBe(unstaged.commit.hash);
    expect((await workspace.openTextDocument(right)).getText()).toBe(original);
  });
  it('未ステージ変更が消えたノードのファイルコメントは入力も保存も行わない', async () => {
    const { directory, api, unstaged } = await uncommittedFixture();
    await runGit(directory, ['add', '-A']);
    input.mockClear();
    await commands.executeCommand('vsreview.addFileComment', unstaged);
    expect(input).not.toHaveBeenCalled();
    expect(api.comments.all).toEqual([]);
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      'VSReview: 選択したファイルには未コミットの変更がなくなりました',
      5000,
    );
  });
  it('選択時に区分別の最新本文を固定し、リポジトリを変更せず、変更消失を通知する', async () => {
    const { directory, git, api, staged, unstaged } = await uncommittedFixture();
    const before = async () => [
      String(await runGit(directory, ['status', '--porcelain'])),
      String(await runGit(directory, ['for-each-ref'])),
    ];
    const state = await before();
    for (const [node, old, next] of [
      [staged, 'one\ntwo\nthree\nfour\nfive\n', 'ONE\ntwo\nthree\nfour\nfive\n'],
      [unstaged, 'ONE\ntwo\nthree\nfour\nfive\n', 'ONE\ntwo\nTHREE\nfour\nFIVE\n'],
    ] as const) {
      await writeFile(join(directory, 'a.ts'), 'ONE\ntwo\nTHREE\nfour\nFIVE\n');
      commands.executeCommand.mockClear();
      await commands.executeCommand('vsreview.openDiff', node);
      const call = commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')!;
      expect(call[3]).toBe(`a.ts (未コミットの変更（${node === staged ? 'ステージ済み' : '未ステージ'}）)`);
      expect((await workspace.openTextDocument(call[1] as vscode.Uri)).getText()).toBe(old);
      expect((await workspace.openTextDocument(call[2] as vscode.Uri)).getText()).toBe(next);
    }
    // 本文の変更はテスト自身が行ったため、比較する状態もその内容で取得する。
    expect((await before())[1]).toBe(state[1]);
    const stable = await before();
    await commands.executeCommand('vsreview.openDiff', unstaged);
    expect(await before()).toEqual(stable);
    await runGit(directory, ['add', '-A']);
    commands.executeCommand.mockClear();
    await commands.executeCommand('vsreview.openDiff', unstaged);
    expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      'VSReview: 選択したファイルには未コミットの変更がなくなりました',
      5000,
    );
    expect(api.commitsTree.git?.root).toBe(git.root);
  });
  it('ツリーのファイルコメントだけ再取得し、保存からの再起動復元は同じURIと3行目を開く', async () => {
    const { directory, state, context, api, unstaged } = await uncommittedFixture();
    if (unstaged.kind !== 'file') {
      throw new Error('file expected');
    }
    await writeFile(join(directory, 'a.ts'), 'ONE\ntwo\nnew snapshot\nfour\nFIVE\n');
    input.mockResolvedValueOnce('file');
    await commands.executeCommand('vsreview.addFileComment', unstaged);
    const file = api.comments.all[0]!;
    expect(file.commit).not.toBe(unstaged.commit.hash);
    expect(file).toMatchObject({ side: 'file', startLine: 0, uncommitted: { kind: 'unstaged' } });
    await commands.executeCommand('vsreview.openComment', file);
    const pair = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
    const right = pair[2] as vscode.Uri;
    await writeFile(join(directory, 'a.ts'), 'later');
    input.mockResolvedValueOnce('URI file');
    await commands.executeCommand('vsreview.addFileComment', right);
    expect(api.comments.all[1]?.commit).toBe(file.commit);
    await commands.executeCommand('vsreview.addRangeComment', {
      thread: controller.createCommentThread(right, new Range(2, 0, 2, 12) as vscode.Range, []),
      text: '名前を変えてください',
    });
    const saved = api.comments.all[2]!;
    expect(saved.startLine).toBe(3);
    for (const subscription of [...context.subscriptions].reverse()) {
      subscription.dispose();
    }
    const restored = (await activate(extensionContext(state)))!;
    await commands.executeCommand('vsreview.openComment', saved);
    const reopened = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
    expect((reopened[1] as vscode.Uri).toString()).toBe((pair[1] as vscode.Uri).toString());
    expect((reopened[2] as vscode.Uri).toString()).toBe(right.toString());
    expect(reopened[4]).toMatchObject({ selection: new Range(2, 0, 2, 12) });
    expect((await workspace.openTextDocument(right)).getText()).toContain('new snapshot');
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearRewrittenComments');
    expect(restored.comments.all).toHaveLength(3);
    expect(documentRef(right)?.uncommitted).toEqual(saved.uncommitted);
    await waitFor(async () => expect((await restored.commitsTree.getChildren())[0]?.kind).toBe('uncommitted'));
    await commands.executeCommand('vsreview.refresh');
    expect((await restored.commitsTree.getChildren())[0]?.kind).toBe('uncommitted');
    expect(restored.comments.all).toHaveLength(3);
  });
  describe('レビューコマンド', () => {
    it('コマンド入口は不正引数を拒否し、検出済み差分へのコメントだけ保存する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 10))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      const access = await accessFor(directory);
      const documents = reviewDocuments(access);
      const state = new MemoryState();
      const comments = new ReviewComments(state, () => {}, documents, access, { review: () => undefined });
      disposeAfter(comments);
      const commits = new CommitsTree(() => comments.all, access, new ChangedFiles(access));
      disposeAfter(commits);
      const rewritten = new RewrittenComments(() => rewrittenTargets(comments.all, documents), access, {
        latestHead: () => undefined,
      });
      disposeAfter(rewritten);
      const context = extensionContext();
      const filesTree = FilesTree.register(
        documents,
        access,
        revisionSnapshots(access, new ChangedFiles(access)),
        archiveLease,
      );
      disposeAfter(filesTree);
      const pullRequestsTree = registerPullRequestsTree(
        {
          get git() {
            return undefined;
          },
        },
        new ChangedFiles(access),
        { gh: (repo) => new GhClient(repo, () => Promise.resolve('[]')) },
      );
      disposeAfter(pullRequestsTree);
      registerReviewCommands(context, {
        archives: revisionArchives(access),
        pullRequestsTree,
        pullRequestCommands: pullRequestCommandsFor(pullRequestsTree),
        filesTree,
        documents,
        comments,
        commitsTree: commits,
        rewritten,
        access,
        diff: new ReviewDiff(
          documents,
          access,
          new ChangedFiles(access),
          { gh: unexpectedGh, remote: () => 'origin' },
          { review: () => undefined },
          archiveLease,
        ),
      });
      await commands.executeCommand('vsreview.openDiff', { ...target, repo: '/outside' });
      expect(commands.executeCommand.mock.calls.some((args) => args[0] === 'vscode.diff')).toBe(false);
      await commands.executeCommand('vsreview.copyHash', { ...target, kind: 'commit' });
      expect(env.clipboard.writeText).toHaveBeenCalledWith(commit.hash);
      for (const value of [null, {}, 'bad']) {
        await commands.executeCommand('vsreview.copyHash', value);
        await commands.executeCommand('vsreview.addRangeComment', value);
        expect(env.clipboard.writeText).toHaveBeenCalledTimes(1);
        expect(state.writes).toEqual([]);
        expect(docs).toEqual([]);
        expect(pick).not.toHaveBeenCalled();
        expect(window.showErrorMessage).not.toHaveBeenCalled();
      }
      const uri = revisionUri(target, 'new');
      const doc = textDocument(uri, await new RevisionProvider(access).provideTextDocumentContent(uri));
      docs.push(doc);
      const thread = controller.createCommentThread(uri, new Range(0, 0, 0, 1) as vscode.Range, []);
      const outside = controller.createCommentThread(
        revisionUri({ ...target, repo: '/outside' }, 'new'),
        new Range(0, 0, 0, 1) as vscode.Range,
        [],
      );
      await commands.executeCommand('vsreview.addRangeComment', { thread: outside, text: '保存不可' });
      expect(comments.all).toEqual([]);
      expect(state.writes).toEqual([]);
      expect(window.showErrorMessage).toHaveBeenLastCalledWith('VSReview: この文書にはコメントを追加できません');
      await commands.executeCommand('vsreview.addRangeComment', { thread, text: '修正してください' });
      expect(comments.all[0]?.body).toBe('修正してください');
      expect(state.writes).toHaveLength(1);
      const saved = comments.all[0]!;
      await commands.executeCommand('vsreview.openComment', saved);
      expect(commands.executeCommand.mock.calls.some((args) => args[0] === 'vscode.diff')).toBe(true);
      await commands.executeCommand('vsreview.editComment', saved);
      const active = threads.find((thread) => thread.comments.length);
      expect(active?.comments[0]?.mode).toBe(CommentMode.Editing);
      await commands.executeCommand('vsreview.cancelEdit', saved);
      expect(active?.comments[0]?.mode).toBe(CommentMode.Preview);
      await commands.executeCommand('vsreview.saveComment', { id: saved.id, body: 'saved through command' });
      expect(comments.all[0]?.body).toBe('saved through command');
      await commands.executeCommand('vsreview.toggleResolved', { kind: 'comment', comment: saved });
      expect(comments.all[0]?.resolved).toBe(true);
      await commands.executeCommand('vsreview.deleteComment', { kind: 'comment', comment: saved });
      expect(comments.all).toEqual([]);
      input.mockResolvedValueOnce('clear through command');
      await commands.executeCommand('vsreview.addFileComment', target);
      expect(comments.all.map((comment) => comment.body)).toEqual(['clear through command']);
      warning.mockResolvedValueOnce('全削除');
      await commands.executeCommand('vsreview.clearComments');
      expect(comments.all).toEqual([]);
    });
    it.each([undefined, { $treeViewId: 'vsreview.comments' }, {}])(
      '出力指定のない引数は範囲と形式を尋ね、未解決のみ出力する: %j',
      async (arg) => {
        const { directory } = await repository();
        workspace.workspaceFolders = [workspaceFolder(directory)];
        const context = extensionContext();
        const comment = { ...reviewComment, repoRoot: directory };
        (context.workspaceState as MemoryState).value = {
          version: 1,
          comments: [comment, { ...comment, id: 'resolved', resolved: true }],
        };
        expect(await activate(context)).toBeDefined();
        pick
          .mockResolvedValueOnce({ scope: 'unresolved' })
          .mockResolvedValueOnce({ format: 'json' })
          .mockResolvedValueOnce({ purpose: 'fix' });

        await commands.executeCommand('vsreview.exportComments', arg);

        expect(pick).toHaveBeenCalledTimes(3);
        expect(pick).toHaveBeenNthCalledWith(1, expect.any(Array), { title: 'エクスポート範囲' });
        expect(pick).toHaveBeenNthCalledWith(2, expect.any(Array), { title: 'エクスポート形式' });
        expect(pick).toHaveBeenNthCalledWith(3, expect.any(Array), { title: 'エクスポート目的' });
        const document = docs.at(-1)!;
        const exported = JSON.parse(document.getText()) as { comments: unknown[] };
        expect(exported.comments).toEqual([comment]);
        expect(window.showTextDocument).toHaveBeenCalledWith(document);
        expect(env.clipboard.writeText).toHaveBeenCalledWith(document.getText());
      },
    );
    it.each([
      [],
      ['scope'],
      new (class ExportOptions {})(),
      Uri.file('/repo'),
      Object.create(null) as unknown,
      Object.create({ scope: 'all' }) as unknown,
      null,
      'bad',
      0,
      { scope: 'other', format: 'json' },
      { scope: 'commit', format: 'json' },
      { scope: 'all', format: 'Markdown' },
      { scope: 'all' },
      { format: 'json' },
      { scope: undefined },
      { format: null },
      { scope: '', format: '' },
      { $treeViewId: 'vsreview.comments', scope: 'other' },
    ])('不正な出力指定は選択画面を開かず通知する: %j', async (arg) => {
      expect(await activate(extensionContext())).toBeDefined();

      await commands.executeCommand('vsreview.exportComments', arg);

      expect(pick).not.toHaveBeenCalled();
      expect(docs).toEqual([]);
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.setStatusBarMessage).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: エクスポートの出力指定が不正です');
    });
    it('登録したコマンドの同期・非同期エラーは画面に通知する', async () => {
      const context = extensionContext();
      registerCommand(context, 'failure', () => {
        throw new Error('failure');
      });
      await commands.executeCommand('vsreview.failure');
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: failure');
      registerCommand(context, 'asyncFailure', () => Promise.reject(new Error('async failure')));
      await commands.executeCommand('vsreview.asyncFailure');
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: async failure');
    });

    it('選択0件・1件・複数件・キャンセル・選択先の除去を扱う', async () => {
      const first = await repository();
      const second = await repository();
      const third = await repository();
      const access = await accessFor(first.directory);
      const commits = new CommitsTree(() => [], access, new ChangedFiles(access));
      disposeAfter(commits);
      await commits.select(first.git);
      const folders = (paths: string[]) => paths.map(workspaceFolder);
      workspace.workspaceFolders = folders([second.directory, third.directory]);
      pick.mockResolvedValueOnce(undefined);
      await selectRepository(access, commits);
      expect(commits.git).toBeUndefined();
      expect(pick).toHaveBeenCalledWith(expect.any(Array), { title: 'リポジトリを選択' });
      pick.mockResolvedValueOnce({ root: third.directory });
      await selectRepository(access, commits);
      expect(commits.git?.root).toBe(third.directory);
      pick.mockResolvedValueOnce(undefined);
      await selectRepository(access, commits);
      expect(commits.git?.root).toBe(third.directory);
      workspace.workspaceFolders = folders([second.directory]);
      await selectRepository(access, commits);
      expect(commits.git?.root).toBe(second.directory);
      workspace.workspaceFolders = [];
      await selectRepository(access, commits);
      expect(commits.git).toBeUndefined();
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'VSReview: ワークスペースに Git リポジトリがありません',
      );
    });
    it('登録コマンドから更新・移動・保存・出力を行い、書き換え済みコメントを削除する', async () => {
      const { directory } = await repository();
      for (const path of ['a', 'b']) {
        await writeFile(join(directory, path), 'one');
      }
      await commitAll(directory, 'one');
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const access = await accessFor(directory);
      const documents = reviewDocuments(access);
      const comments = new ReviewComments(new MemoryState(), () => {}, documents, access, { review: () => undefined });
      disposeAfter(comments);
      const commitsTree = new CommitsTree(() => comments.all, access, new ChangedFiles(access));
      disposeAfter(commitsTree);
      const rewritten = new RewrittenComments(() => rewrittenTargets(comments.all, documents), access, {
        latestHead: () => undefined,
      });
      disposeAfter(rewritten);
      const commentsTree = new CommentsTree(() => comments.all, rewritten);
      disposeAfter(commentsTree);
      const context = extensionContext();
      context.subscriptions.push(
        workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)),
      );
      const filesTree = FilesTree.register(
        documents,
        access,
        revisionSnapshots(access, new ChangedFiles(access)),
        archiveLease,
      );
      disposeAfter(filesTree);
      const pullRequestsTree = registerPullRequestsTree(
        {
          get git() {
            return undefined;
          },
        },
        new ChangedFiles(access),
        { gh: (repo) => new GhClient(repo, () => Promise.resolve('[]')) },
      );
      disposeAfter(pullRequestsTree);
      registerReviewCommands(context, {
        archives: revisionArchives(access),
        pullRequestsTree,
        pullRequestCommands: pullRequestCommandsFor(pullRequestsTree),
        filesTree,
        documents,
        comments,
        commitsTree,
        rewritten,
        access,
        diff: new ReviewDiff(
          documents,
          access,
          new ChangedFiles(access),
          { gh: unexpectedGh, remote: () => 'origin' },
          { review: () => undefined },
          archiveLease,
        ),
      });
      await commands.executeCommand('vsreview.refresh');
      await commands.executeCommand('vsreview.selectRepository');
      expect(commitsTree.git?.root).toBe(directory);
      const root = (await commitsTree.getChildren())[0]!;
      const node = (await commitsTree.getChildren(root))[0]!;
      if (node.kind !== 'file') {
        throw new Error('missing file');
      }
      await commands.executeCommand('vsreview.nextFile', node);
      expect(commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')?.[3]).toContain('b (');
      commands.executeCommand.mockClear();
      await commands.executeCommand('vsreview.previousFile', { ...node, file: { ...node.file, path: 'b' } });
      expect(commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')?.[3]).toContain('a (');
      await commands.executeCommand('vsreview.openDiff', node);
      const workingUris = await documents.diffUris(node);
      activateTab(new TabInputTextDiff(workingUris.left, workingUris.right));
      window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: new TabInputText(workingUris.right) }] });
      input.mockResolvedValueOnce('working file comment');
      await commands.executeCommand('vsreview.addFileComment', Uri.file(join(directory, 'a')));
      expect(comments.all[0]?.body).toBe('working file comment');
      await commands.executeCommand('vsreview.deleteComment', comments.all[0]);
      const uri = revisionUri(node, 'new');
      await window.showTextDocument(await workspace.openTextDocument(uri));
      input.mockResolvedValueOnce('file comment');
      await commands.executeCommand('vsreview.addFileComment', uri);
      input.mockResolvedValueOnce('active comment');
      await commands.executeCommand('vsreview.addFileComment');
      expect(comments.all.map((comment) => comment.body)).toEqual(['file comment', 'active comment']);
      await commands.executeCommand('vsreview.openWorkingFile');
      expect(window.showTextDocument).toHaveBeenLastCalledWith(Uri.file(join(directory, 'a')), {
        selection: new Range(0, 0, 0, 0),
      });
      await commands.executeCommand('vsreview.exportComments', { scope: 'all', format: 'json' });
      expect(JSON.parse(docs.at(-1)!.getText())).toMatchObject({
        comments: [
          expect.objectContaining({ body: 'file comment' }),
          expect.objectContaining({ body: 'active comment' }),
        ],
      });
      const outside = { ...node, repo: '/outside' };
      env.clipboard.writeText.mockClear();
      await commands.executeCommand('vsreview.copyHash', outside);
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      await commitAll(directory, 'amended', { amend: true });
      globalConfiguration.set('vsreview.autoRefresh', false);
      const changed = vi.fn();
      commentsTree.onDidChangeTreeData(changed);
      await commands.executeCommand('vsreview.selectRepository');
      expect(rewritten.has(comments.all[0]!)).toBe(true);
      expect(changed).toHaveBeenCalled();
      changed.mockClear();
      await commands.executeCommand('vsreview.refresh');
      expect(rewritten.has(comments.all[0]!)).toBe(true);
      expect(changed).toHaveBeenCalled();
      warning.mockResolvedValueOnce('削除');
      await commands.executeCommand('vsreview.clearRewrittenComments');
      expect(comments.all).toEqual([]);
    });

    it('管理外の保存コメントは差分を開かず、作業対象のないコマンドだけ理由を通知する', async () => {
      const { directory } = await repository();
      const access = await accessFor(directory);
      const state = new MemoryState();
      state.value = { version: 1, comments: [{ ...reviewComment, repoRoot: '/outside' }] };
      const documents = reviewDocuments(access);
      const comments = new ReviewComments(state, () => {}, documents, access, { review: () => undefined });
      disposeAfter(comments);
      const commitsTree = new CommitsTree(() => comments.all, access, new ChangedFiles(access));
      disposeAfter(commitsTree);
      const rewritten = new RewrittenComments(() => rewrittenTargets(comments.all, documents), access, {
        latestHead: () => undefined,
      });
      disposeAfter(rewritten);
      const commentsTree = new CommentsTree(() => comments.all, rewritten);
      disposeAfter(commentsTree);
      const context = extensionContext();
      const filesTree = FilesTree.register(
        documents,
        access,
        revisionSnapshots(access, new ChangedFiles(access)),
        archiveLease,
      );
      disposeAfter(filesTree);
      const pullRequestsTree = registerPullRequestsTree(
        {
          get git() {
            return undefined;
          },
        },
        new ChangedFiles(access),
        { gh: (repo) => new GhClient(repo, () => Promise.resolve('[]')) },
      );
      disposeAfter(pullRequestsTree);
      registerReviewCommands(context, {
        archives: revisionArchives(access),
        pullRequestsTree,
        pullRequestCommands: pullRequestCommandsFor(pullRequestsTree),
        filesTree,
        documents,
        comments,
        commitsTree,
        rewritten,
        access,
        diff: new ReviewDiff(
          documents,
          access,
          new ChangedFiles(access),
          { gh: unexpectedGh, remote: () => 'origin' },
          { review: () => undefined },
          archiveLease,
        ),
      });
      await commands.executeCommand('vsreview.openComment', { id: reviewComment.id });
      expect(commands.executeCommand.mock.calls.some((args) => args[0] === 'vscode.diff')).toBe(false);
      await window.showTextDocument(textDocument(Uri.file('/outside') as vscode.Uri, 'x'));
      await commands.executeCommand('vsreview.openWorkingFile');
      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        'VSReview: レビュー文書ではありません',
        expect.any(Number),
      );
    });

    it('loadMoreは表示コミット数を増やす', async () => {
      const { directory } = await repository();
      for (let i = 0; i < COMMIT_PAGE_SIZE + 1; i++) {
        await writeFile(join(directory, 'file'), String(i));
        await commitAll(directory, `commit ${i}`);
      }
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(() => expect(api.commitsTree.git).toBeDefined());
      expect((await api.commitsTree.getChildren()).filter((node) => node.kind === 'commit')).toHaveLength(
        COMMIT_PAGE_SIZE,
      );
      await commands.executeCommand('vsreview.loadMore');
      expect((await api.commitsTree.getChildren()).filter((node) => node.kind === 'commit')).toHaveLength(
        COMMIT_PAGE_SIZE + 1,
      );
      expect((await api.commitsTree.getChildren()).some((node) => node.kind === 'more')).toBe(false);
    });
    it('選択待ちに検出対象から消えた候補を選んでも現在の選択を変えない', async () => {
      const first = await repository();
      const second = await repository();
      const access = await accessFor(first.directory);
      const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
      disposeAfter(tree);
      await tree.select(first.git);
      workspace.workspaceFolders = [workspaceFolder(first.directory), workspaceFolder(second.directory, 1)];
      let release: (value: { root: string }) => void = () => {};
      pick.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = selectRepository(access, tree);
      await waitFor(() => expect(pick).toHaveBeenCalled());
      await access.discover([workspaceFolder(first.directory)]);
      release({ root: second.directory });
      await pending;
      expect(tree.git?.root).toBe(first.directory);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });
  });

  describe('PR の更新コマンド', () => {
    it('gh が応答しなくてもリポジトリ更新はコメント更新と監視開始を完了する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one\n');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      const saved = {
        ...reviewComment,
        repoRoot: directory,
        commit: commit.hash,
        parent: target.parent,
        path: 'file',
        status: 'A' as const,
        side: 'new' as const,
        startLine: 1,
        endLine: 1,
      };
      const state = new MemoryState();
      state.value = serialize([saved]);
      const access = await accessFor(directory);
      const changedFiles = new ChangedFiles(access);
      const commitsTree = new CommitsTree(() => [], access, changedFiles);
      disposeAfter(commitsTree);
      await commitsTree.select(git);
      const documents = reviewDocuments(access);
      const comments = new ReviewComments(state, () => {}, documents, access, { review: () => undefined });
      disposeAfter(comments);
      docs.push(textDocument(revisionUri(target, 'new'), 'one\n'));
      const rewritten = new RewrittenComments(() => Promise.resolve([]), access, { latestHead: () => undefined });
      disposeAfter(rewritten);
      let finish!: (json: string) => void;
      const pullRequestsTree = registerPullRequestsTree(commitsTree, changedFiles, {
        gh: (repo) =>
          new GhClient(
            repo,
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          ),
      });
      disposeAfter(pullRequestsTree);
      const auto = new AutoRefresh(access, commitsTree, rewritten, documents);
      disposeAfter(auto);
      await updateRepository({
        access,
        commitsTree,
        pullRequestsTree,
        comments,
        rewritten,
        rewatch: () => auto.rewatch({ refresh: false }),
      });
      expect(threads.some((thread) => thread.comments.some((comment) => comment.body === saved.body))).toBe(true);
      expect(watchers.some((watcher) => !watcher.disposed)).toBe(true);
      expect(pullRequestsTree.view.message).toContain('取得中');
      finish('[]');
      await waitFor(() => expect(pullRequestsTree.view.message).toContain('ありません'));
    });
  });
});

async function setupCommentNodes(additional: (first: ReviewComment) => ReviewComment[] = () => []) {
  const { directory } = await repository();
  workspace.workspaceFolders = [workspaceFolder(directory)];
  const first = { ...reviewComment, repoRoot: directory };
  const pr = { ...first, id: 'pr', pullRequest: pullRequestReview };
  const state = new MemoryState();
  state.value = serialize([
    first,
    { ...first, id: 'file', side: 'file', startLine: 0, endLine: 0 },
    { ...first, id: 'other-path', path: 'other.ts' },
    { ...first, id: 'other-repo', repoRoot: '/other' },
    pr,
    { ...pr, id: 'old-pr', commit: 'c'.repeat(40), pullRequest: { ...pullRequestReview, headRefOid: 'c'.repeat(40) } },
    { ...pr, id: 'other-pr', pullRequest: { ...pullRequestReview, number: 13 } },
    ...additional(first),
  ]);
  const api = (await activate(extensionContext(state)))!;
  const tree = window.createTreeView.mock.calls.find(([id]) => id === 'vsreview.comments')![1]
    .treeDataProvider as CommentsTree;
  return { api, tree, state, first };
}

function commentGroup(tree: CommentsTree, id: string) {
  return tree.getChildren().find((node) => node.kind === 'group' && node.comments.some((c) => c.id === id))!;
}
function commentFile(tree: CommentsTree, id: string, path: string) {
  return tree.getChildren(commentGroup(tree, id)).find((node) => node.kind === 'file' && node.label === path)!;
}

describe('コメントノードの一括削除コマンド', () => {
  it.each([
    [
      'clearCommitComments',
      'one',
      false,
      'VSReview: このコミットのコメント 3 件を削除しますか？',
      ['other-repo', 'pr', 'old-pr', 'other-pr'],
    ],
    [
      'clearFileComments',
      'one',
      true,
      'VSReview: このファイルのコメント 2 件を削除しますか？',
      ['other-path', 'other-repo', 'pr', 'old-pr', 'other-pr'],
    ],
    [
      'clearPullRequestComments',
      'pr',
      false,
      'VSReview: この PR のコメント 2 件を削除しますか？',
      ['one', 'file', 'other-path', 'other-repo', 'other-pr'],
    ],
    [
      'clearFileComments',
      'pr',
      true,
      'VSReview: このファイルのコメント 2 件を削除しますか？',
      ['one', 'file', 'other-path', 'other-repo', 'other-pr'],
    ],
  ] as const)('%s / %s / file=%s はノードの範囲だけを削除する', async (command, id, file, message, remaining) => {
    const { api, tree, first } = await setupCommentNodes();
    const node = file ? commentFile(tree, id, first.path) : commentGroup(tree, id);
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand(`vsreview.${command}`, node);
    expect(api.comments.all.map((c) => c.id)).toEqual(remaining);
    expect(warning).toHaveBeenCalledExactlyOnceWith(message, { modal: true }, '削除');
    expect(tree.getChildren().flatMap((n) => (n.kind === 'group' ? n.comments.map((c) => c.id) : []))).toEqual(
      remaining,
    );
  });

  it('キャンセル時には確認だけを表示し、保存しない', async () => {
    const { api, tree, state } = await setupCommentNodes();
    await commands.executeCommand('vsreview.clearCommitComments', commentGroup(tree, 'one'));
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: このコミットのコメント 3 件を削除しますか？',
      { modal: true },
      '削除',
    );
    expect(api.comments.all).toHaveLength(7);
    expect(state.writes).toEqual([]);
  });

  it.each([undefined, null, {}, 'bad', { kind: 'group', label: '', comments: [null] }, { kind: 'file', comments: [] }])(
    '不正引数 %j では何もしない',
    async (argument) => {
      const { api, state } = await setupCommentNodes();
      await commands.executeCommand('vsreview.clearCommitComments', argument);
      expect(warning).not.toHaveBeenCalled();
      expect(state.writes).toEqual([]);
      expect(api.comments.all).toHaveLength(7);
    },
  );

  it.each([
    ['clearCommitComments', 'pr', false],
    ['clearCommitComments', 'one', true],
    ['clearPullRequestComments', 'one', false],
    ['clearPullRequestComments', 'pr', true],
    ['clearFileComments', 'one', false],
    ['clearFileComments', 'pr', false],
  ] as const)('%s に異なる種類 %s / file=%s を渡しても何もしない', async (command, id, file) => {
    const { api, tree, state, first } = await setupCommentNodes();
    const node = file ? commentFile(tree, id, first.path) : commentGroup(tree, id);
    await commands.executeCommand(`vsreview.${command}`, node);
    expect(warning).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    expect(api.comments.all).toHaveLength(7);
  });

  it.each(['clearCommitComments', 'clearPullRequestComments', 'clearFileComments'])(
    '%s はコメントノードを受け付けない',
    async (command) => {
      const { tree, state, first } = await setupCommentNodes();
      const leaf = tree.getChildren(commentFile(tree, 'one', first.path)).find((node) => node.kind === 'comment')!;
      await commands.executeCommand(`vsreview.${command}`, leaf);
      expect(warning).not.toHaveBeenCalled();
      expect(state.writes).toEqual([]);
    },
  );

  it('空ノードでは確認も保存もしない', async () => {
    const { state } = await setupCommentNodes();
    await commands.executeCommand('vsreview.clearCommitComments', { kind: 'group', label: '', comments: [] });
    expect(warning).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it('削除済みノードでは確認も保存もしない', async () => {
    const { tree, state } = await setupCommentNodes();
    const group = commentGroup(tree, 'one');
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearCommitComments', group);
    const writes = [...state.writes];
    warning.mockClear();
    await commands.executeCommand('vsreview.clearCommitComments', group);
    expect(warning).not.toHaveBeenCalled();
    expect(state.writes).toEqual(writes);
  });
  it('確認中の追加を残し、確定した対象の削除をスレッドと両ツリーに反映する', async () => {
    const { api, tree, first } = await setupCommentNodes();
    const group = commentGroup(tree, 'one');
    const doc = textDocument(revisionUri(targetFromComment(first), 'new'), 'one\ntwo\nthree\nfour');
    docs.push(doc);
    await documentOpened.fireAsync(doc);
    const deletedThread = threads.find((thread) => thread.comments.some((c) => 'id' in c && c.id === first.id))!;
    expect(deletedThread).toBeDefined();
    const commitsChanged = vi.fn();
    const commentsChanged = vi.fn();
    api.commitsTree.onDidChangeTreeData(commitsChanged);
    tree.onDidChangeTreeData(commentsChanged);
    let confirm: ((value: string) => void) | undefined;
    warning.mockImplementationOnce(() => new Promise<string>((resolve) => (confirm = resolve)));
    const deleting = commands.executeCommand('vsreview.clearCommitComments', group);
    await waitFor(() => expect(confirm).toBeDefined());
    input.mockResolvedValueOnce('added during confirmation');
    await commands.executeCommand('vsreview.addFileComment', targetFromComment(first));
    commentsChanged.mockClear();
    commitsChanged.mockClear();
    confirm!('削除');
    await deleting;
    expect(api.comments.all.map((c) => c.body)).toContain('added during confirmation');
    const added = api.comments.all.find((c) => c.body === 'added during confirmation')!;
    expect(api.comments.all.map((c) => c.id)).toEqual(['other-repo', 'pr', 'old-pr', 'other-pr', added.id]);
    expect(disposedThreads.has(deletedThread)).toBe(true);
    expect(
      api.commitsTree.getTreeItem({ kind: 'file', name: first.path, ...targetFromComment(first) }).description,
    ).toContain('1 コメント');
    await waitFor(() => expect(commentsChanged).toHaveBeenCalled());
    expect(commitsChanged).toHaveBeenCalled();
    expect(
      tree.getTreeItem(
        tree
          .getChildren()
          .find(
            (node) => node.kind !== 'comment' && node.comments.some((c) => c.body === 'added during confirmation'),
          )!,
      ).description,
    ).toContain('1 コメント');
  });

  it('PR のファイル削除では同じ PR の別パスを残す', async () => {
    const { api, tree, first } = await setupCommentNodes((comment) => [
      { ...comment, id: 'pr-other-path', path: 'other.ts', pullRequest: pullRequestReview },
    ]);
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearFileComments', commentFile(tree, 'pr', first.path));
    expect(api.comments.all.map((c) => c.id)).toEqual([
      'one',
      'file',
      'other-path',
      'other-repo',
      'other-pr',
      'pr-other-path',
    ]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: このファイルのコメント 2 件を削除しますか？',
      { modal: true },
      '削除',
    );
  });

  it('描画後に同じ比較へ追加されたコメントも実行時の対象に含める', async () => {
    const { api, tree, first } = await setupCommentNodes();
    const group = commentGroup(tree, 'one');
    input.mockResolvedValueOnce('added before execution');
    await commands.executeCommand('vsreview.addFileComment', targetFromComment(first));
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearCommitComments', group);
    expect(api.comments.all.map((c) => c.id)).toEqual(['other-repo', 'pr', 'old-pr', 'other-pr']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: このコミットのコメント 4 件を削除しますか？',
      { modal: true },
      '削除',
    );
  });

  it('書き換え済みグループも指定した範囲だけ削除する', async () => {
    const { api, tree } = await setupCommentNodes();
    const group = commentGroup(tree, 'one');
    await waitFor(() => expect(tree.getTreeItem(group).description).toContain('書き換え済み'));
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearCommitComments', group);
    expect(api.comments.all.map((c) => c.id)).toEqual(['other-repo', 'pr', 'old-pr', 'other-pr']);
  });

  it('各メニューは対象ノードだけに表示し、パレットには表示しない', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      contributes: { commands: unknown[]; menus: Record<string, unknown[]> };
    };
    for (const [name, title, context] of [
      ['clearCommitComments', 'このコミットのコメントを削除', 'commentCommitGroup'],
      ['clearPullRequestComments', 'この PR のコメントを削除', 'commentPullRequestGroup'],
      ['clearFileComments', 'このファイルのコメントを削除', 'commentFile'],
    ]) {
      const command = `vsreview.${name}`;
      expect(manifest.contributes.commands).toContainEqual({ command, title: `VSReview: ${title}` });
      expect(manifest.contributes.menus['view/item/context']).toContainEqual({
        command,
        when: `view == vsreview.comments && viewItem == ${context}`,
      });
      expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    }
  });

  it('保存失敗を通知して対象を保持し、次の削除を実行できる', async () => {
    const { api, tree, state } = await setupCommentNodes();
    const group = commentGroup(tree, 'one');
    state.fail = true;
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearCommitComments', group);
    expect(api.comments.all).toHaveLength(7);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: disk full');
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearCommitComments', group);
    expect(api.comments.all).toHaveLength(4);
  });
});
