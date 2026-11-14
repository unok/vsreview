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
import { exportMarkdown } from '../src/core/export';
import { AutoRefresh } from '../src/ui/autoRefresh';
import { serialize, type ReviewComment } from '../src/core/model';
import { GhClient } from '../src/git/gh';
import { ChangedFiles } from '../src/ui/repositories';
import { FilesTree } from '../src/ui/files';
import type * as vscode from 'vscode';
import { targetFromComment } from '../src/core/documents';
import { activate } from '../src/extension';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll } from './gitFixtures';
import { ReviewComments } from '../src/ui/comments';
import { ReviewDiff } from '../src/ui/diff';
import { CommitsTree, CommentsTree, COMMIT_PAGE_SIZE } from '../src/ui/trees';
import { RewrittenComments, rewrittenTargets } from '../src/ui/rewritten';
import { registerReviewCommands, selectRepository, updateRepository } from '../src/ui/commands';
import { registerCommand } from '../src/ui/common';
import { revisionUri, RevisionProvider, documentRef } from '../src/ui/revisions';
import { GitClient, runGit } from '../src/git/client';
import { createUncommittedChanges } from '../src/git/uncommitted';
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
  workspaceConfiguration,
  workspace,
  Uri,
  input,
  watchers,
  warning,
  disposedThreads,
  documentOpened,
} from './vscodeMock';

describe('commands', () => {
  it('未コミットの変更済み判定を再取得せずにコマンドの両形式へ渡す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'saved');
    const snapshot = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const saved = {
      ...reviewComment,
      repoRoot: directory,
      commit: snapshot.unstaged.commit.hash,
      parent: snapshot.unstaged.parent,
      path: 'file',
      status: 'A' as const,
      side: 'file' as const,
      startLine: 0,
      endLine: 0,
      uncommitted: { kind: 'unstaged' as const, createdAt: snapshot.createdAt },
    };
    delete saved.oldPath;
    await writeFile(join(directory, 'file'), 'edited');
    const current = await createUncommittedChanges(git, '2026-11-15T00:00:00Z');
    const unchanged = {
      ...saved,
      id: 'unchanged',
      commit: current.unstaged.commit.hash,
      parent: current.unstaged.parent,
      uncommitted: { ...saved.uncommitted, createdAt: current.createdAt },
    };
    const state = new MemoryState();
    state.value = serialize([saved, unchanged]);
    const access = await accessFor(directory);
    const documents = reviewDocuments(access);
    const comments = new ReviewComments(state, () => {}, documents, access, { review: () => undefined });
    const changed = new ChangedFiles(access);
    const commitsTree = new CommitsTree(() => comments.all, access, changed);
    const capture = vi.fn(() => createUncommittedChanges(git, '2026-11-15T00:00:00Z'));
    const rewritten = new RewrittenComments(
      () => Promise.resolve(comments.all),
      access,
      { latestHead: () => undefined },
      capture,
    );
    const filesTree = FilesTree.register(documents, access, revisionSnapshots(access, changed), archiveLease);
    const pullRequestsTree = registerPullRequestsTree(commitsTree, changed, { comments: () => comments.all });
    for (const resource of [comments, commitsTree, rewritten, filesTree, pullRequestsTree]) {
      disposeAfter(resource);
    }
    registerReviewCommands(extensionContext(), {
      archives: revisionArchives(access),
      filesTree,
      documents,
      comments,
      commitsTree,
      rewritten,
      access,
      pullRequestsTree,
      pullRequestCommands: pullRequestCommandsFor(pullRequestsTree),
      diff: new ReviewDiff(
        documents,
        access,
        changed,
        { gh: unexpectedGh, remote: () => 'origin' },
        { review: () => undefined },
        archiveLease,
      ),
    });
    await rewritten.refresh();
    expect(rewritten.has(saved)).toBe(true);
    expect(rewritten.has(unchanged)).toBe(false);
    expect(capture).toHaveBeenCalledTimes(1);
    for (const format of ['json', 'markdown']) {
      await commands.executeCommand('vsreview.exportComments', { scope: 'uncommitted', format });
      const output = docs.at(-1)!.getText();
      if (format === 'json') {
        expect(JSON.parse(output)).toMatchObject({
          comments: [saved, unchanged],
          uncommittedSnapshots: [{ changed: true }, { changed: false }],
        });
      } else {
        expect(output).toContain('内容が変更済み: はい');
        expect(output).toContain('内容が変更済み: いいえ');
      }
      expect(env.clipboard.writeText).toHaveBeenLastCalledWith(output);
    }
    const documentsBeforeCopy = [...docs];
    await commands.executeCommand('vsreview.copyInstructions', {
      kind: 'uncommittedGroup',
      label: '未ステージ',
      comments: [saved, unchanged],
    });
    expect(env.clipboard.writeText).toHaveBeenLastCalledWith(
      exportMarkdown([saved, unchanged], new Map([[directory, 'main']]), '', '', rewritten.has),
    );
    expect(docs).toEqual(documentsBeforeCopy);
    expect(capture).toHaveBeenCalledTimes(1);
  });
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
    warning.mockResolvedValueOnce(undefined);
    await commands.executeCommand('vsreview.clearRewrittenComments');
    expect(warning).toHaveBeenCalledWith(
      'VSReview: 内容が変更済みの未コミットのコメント 3 件を削除しますか？',
      { modal: true },
      '削除',
    );
    expect(restored.comments.all).toHaveLength(3);
    expect(documentRef(right)?.uncommitted).toEqual(saved.uncommitted);
    await waitFor(async () => expect((await restored.commitsTree.getChildren())[0]?.kind).toBe('uncommitted'));
    await commands.executeCommand('vsreview.refresh');
    expect((await restored.commitsTree.getChildren())[0]?.kind).toBe('uncommitted');
    expect(restored.comments.all).toHaveLength(3);
    const { commonDir } = await (await accessFor(directory)).client(directory).directories();
    await rm(join(commonDir, 'objects', saved.commit.slice(0, 2), saved.commit.slice(2)));
    const tree = window.createTreeView.mock.calls.filter(([id]) => id === 'vsreview.comments').at(-1)![1]
      .treeDataProvider as CommentsTree;
    expect(tree.getTreeItem({ kind: 'comment', comment: saved }).tooltip).toBe(`${saved.body}\n\n${saved.excerpt}`);
    commands.executeCommand.mockClear();
    await commands.executeCommand('vsreview.openComment', saved);
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('スナップショットのオブジェクトが見つからない'),
    );
    expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('削除コマンドは作業ツリーの最新状態を判定し、変更済みだけを削除する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'base');
    await commitAll(directory, 'base');
    const initial = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const saved = {
      ...reviewComment,
      repoRoot: directory,
      commit: initial.unstaged.commit.hash,
      parent: initial.unstaged.parent,
      uncommitted: { kind: 'unstaged' as const, createdAt: initial.createdAt },
    };
    await writeFile(join(directory, 'a'), 'edited');
    const current = await createUncommittedChanges(git, '2026-11-14T01:00:00Z');
    const state = new MemoryState();
    state.value = serialize([
      saved,
      { ...saved, id: 'second' },
      { ...saved, id: 'unchanged', commit: current.unstaged.commit.hash, parent: current.unstaged.parent },
      { ...reviewComment, id: 'rewritten', repoRoot: directory },
      { ...reviewComment, id: 'reachable', repoRoot: directory, commit: (await git.head())! },
    ]);
    workspace.workspaceFolders = [workspaceFolder(directory)];
    globalConfiguration.set('vsreview.autoRefresh', false);
    const api = (await activate(extensionContext(state)))!;
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearRewrittenComments');
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: 書き換え済みコミットのコメント 1 件、内容が変更済みの未コミットのコメント 2 件を削除しますか？',
      { modal: true },
      '削除',
    );
    expect(api.comments.all.map((c) => c.id)).toEqual(['unchanged', 'reachable']);
    // 削除後に始まる判定を回収し、fixture の破棄と競合させない。
    await commands.executeCommand('vsreview.refresh');
  });
  it('変更済み判定後に内容を戻し、取得が失敗したら削除の確認も保存もしない', async () => {
    const { directory, api, state, unstaged } = await uncommittedFixture();
    input.mockResolvedValueOnce('保存するコメント');
    await commands.executeCommand('vsreview.addFileComment', unstaged);
    // 追加後の非同期判定を終えてから、取得失敗を注入する。
    await commands.executeCommand('vsreview.refresh');
    const saved = [...api.comments.all];
    expect(saved).toHaveLength(1);
    await writeFile(join(directory, 'a.ts'), 'edited');
    warning.mockResolvedValueOnce(undefined);
    await commands.executeCommand('vsreview.clearRewrittenComments');
    expect(warning).toHaveBeenCalledWith(
      'VSReview: 内容が変更済みの未コミットのコメント 1 件を削除しますか？',
      { modal: true },
      '削除',
    );
    await writeFile(join(directory, 'a.ts'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
    const writes = [...state.writes];
    const head = vi.spyOn(GitClient.prototype, 'head').mockRejectedValue(new Error('snapshot unavailable'));
    warning.mockClear().mockResolvedValueOnce('削除');
    try {
      await commands.executeCommand('vsreview.clearRewrittenComments');
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: snapshot unavailable');
      expect(warning).not.toHaveBeenCalled();
      expect(api.comments.all).toEqual(saved);
      expect(state.writes).toEqual(writes);
    } finally {
      head.mockRestore();
      // 失敗経路でも進行中の判定を回収してから fixture を破棄する。
      await commands.executeCommand('vsreview.refresh');
    }
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
      await commands.executeCommand('vsreview.togglePurpose', { kind: 'comment', comment: saved });
      expect(comments.all[0]).toMatchObject({ purpose: 'question', resolved: true });
      await commands.executeCommand('vsreview.deleteComment', { kind: 'comment', comment: saved });
      expect(comments.all).toEqual([]);
      input.mockResolvedValueOnce('clear through command');
      await commands.executeCommand('vsreview.addFileComment', target);
      expect(comments.all.map((comment) => comment.body)).toEqual(['clear through command']);
      warning.mockResolvedValueOnce('全削除');
      await commands.executeCommand('vsreview.clearComments');
      expect(comments.all).toEqual([]);
    });
    it.each(['markdown', 'json'] as const)(
      '対話引数の種別を保持し、ビューのボタンは全種別を出す: %s',
      async (format) => {
        const { api } = await setupCommentNodes((first) => [
          { ...first, id: 'question', purpose: 'question', body: '対話の質問本文' },
        ]);
        const question = api.comments.all.find((comment) => comment.id === 'question')!;
        const fixes = api.comments.all.filter((comment) => comment.id !== 'question');
        for (const [argument, selection] of [
          [{ purpose: 'question' }, 'question'],
          [{ purpose: 'fix' }, 'fix'],
          [{ $treeViewId: 'vsreview.comments' }, 'all'],
        ] as const) {
          pick.mockResolvedValueOnce({ scope: 'all' }).mockResolvedValueOnce({ format });
          await commands.executeCommand('vsreview.exportComments', argument);
          const content = docs.at(-1)!.getText();
          const expected = selection === 'question' ? [question] : selection === 'fix' ? fixes : api.comments.all;
          if (format === 'json') {
            expect(JSON.parse(content)).toMatchObject({ purpose: selection === 'all' ? 'mixed' : selection });
            expect((JSON.parse(content) as { comments: unknown[] }).comments).toEqual(expected);
          } else {
            expect(content.match(/^コメント本文:$/gm)).toHaveLength(expected.length);
            expect(content.match(/^種別: 修正依頼$/gm) ?? []).toHaveLength(selection === 'question' ? 0 : fixes.length);
            expect(content.match(/^種別: 質問$/gm) ?? []).toHaveLength(selection === 'fix' ? 0 : 1);
          }
          expect(env.clipboard.writeText).toHaveBeenLastCalledWith(content);
        }
      },
    );
    it('対話引数でも不正な purpose は選択画面を出す前に拒否する', async () => {
      await activate(extensionContext());
      for (const purpose of [null, '', 'edit', 0, false, [], {}]) {
        await commands.executeCommand('vsreview.exportComments', { purpose });
        expect(window.showErrorMessage).toHaveBeenLastCalledWith('VSReview: エクスポートの出力指定が不正です');
      }
      expect(pick).not.toHaveBeenCalled();
      expect(docs).toEqual([]);
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
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
        pick.mockResolvedValueOnce({ scope: 'unresolved' }).mockResolvedValueOnce({ format: 'json' });

        await commands.executeCommand('vsreview.exportComments', arg);

        expect(pick).toHaveBeenCalledTimes(2);
        expect(pick).toHaveBeenNthCalledWith(1, expect.any(Array), { title: 'エクスポート範囲' });
        expect(pick).toHaveBeenNthCalledWith(2, expect.any(Array), { title: 'エクスポート形式' });
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
      { scope: 'uncommitted', format: 'Markdown' },
      { scope: 'uncommitted' },
      { scope: 'uncommitted', format: 'json', purpose: 'edit' },
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
  const rewatch = vi.spyOn(AutoRefresh.prototype, 'rewatch');
  const api = (await activate(extensionContext(state)))!;
  // activate は初回更新を待たずに戻る。初回更新の最後に呼ばれる rewatch の完了まで待ち、
  // スナップショットの Git 書き込みと一時リポジトリの削除を競合させない。
  await waitFor(() => expect(rewatch.mock.settledResults[0]?.type).toBe('fulfilled'));
  rewatch.mockRestore();
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
  it('未コミットの各グループではコミット削除を拒否し、ファイル削除はSHAも区別する', async () => {
    const { api, tree, first, state } = await setupCommentNodes((c) => [
      { ...c, id: 's1', commit: 'e'.repeat(40), uncommitted: { kind: 'staged', createdAt: c.createdAt } },
      { ...c, id: 's2', commit: 'd'.repeat(40), uncommitted: { kind: 'staged', createdAt: c.createdAt } },
      { ...c, id: 's3', commit: 'e'.repeat(40), uncommitted: { kind: 'unstaged', createdAt: c.createdAt } },
      { ...c, id: 'same-hash-commit', commit: 'e'.repeat(40) },
    ]);
    const group = tree.getChildren().find((node) => node.kind === 'uncommittedGroup')!;
    const snapshots = tree.getChildren(group);
    for (const node of [
      group,
      ...snapshots,
      { kind: 'group', label: '', comments: [api.comments.all.find((c) => c.id === 's1')!] },
    ]) {
      await commands.executeCommand('vsreview.clearCommitComments', node);
    }
    expect(warning).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearFileComments', tree.getChildren(snapshots[0])[0]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: このファイルのコメント 1 件を削除しますか？',
      { modal: true },
      '削除',
    );
    expect(api.comments.all.some((c) => c.id === 's1')).toBe(false);
    expect(api.comments.all.some((c) => c.id === 's2' && c.path === first.path)).toBe(true);
    expect(api.comments.all.some((c) => c.id === 's3')).toBe(true);
    expect(api.comments.all.some((c) => c.id === 'same-hash-commit')).toBe(true);
    // 削除後に始まる判定を回収し、fixture の破棄と競合させない。
    await commands.executeCommand('vsreview.refresh');
  });
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

  it('種別切り替えは保存済みスレッドとコメントノードだけに表示する', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      contributes: { commands: unknown[]; menus: Record<string, { command: string }[]> };
    };
    const command = 'vsreview.togglePurpose';
    expect(manifest.contributes.commands).toContainEqual({
      command,
      title: 'VSReview: コメントの種別を切り替え',
      icon: '$(arrow-swap)',
    });
    expect(manifest.contributes.menus['comments/commentThread/title']).toContainEqual({
      command,
      group: 'navigation',
      when: 'commentController == vsreview && commentThread == vsreview.savedThread',
    });
    expect(manifest.contributes.menus['view/item/context']).toContainEqual({
      command,
      when: 'view == vsreview.comments && viewItem == comment',
    });
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    expect(
      Object.entries(manifest.contributes.menus)
        .filter(([, entries]) => entries.some((entry) => entry.command === command))
        .map(([name]) => name)
        .sort(),
    ).toEqual(['commandPalette', 'comments/commentThread/title', 'view/item/context']);
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

describe('指示をクリップボードにコピー', () => {
  async function setupCopyNodes(additional?: (first: ReviewComment) => ReviewComment[]) {
    const fixture = await setupCommentNodes(additional);
    await commands.executeCommand('vsreview.refresh');
    window.showErrorMessage.mockClear();
    return fixture;
  }
  beforeEach(() => {
    vi.spyOn(workspace, 'openTextDocument');
  });
  function expectCopy(
    selected: readonly ReviewComment[],
    instructions = '',
    questionInstructions = '',
    branch = 'main',
    rewritten: (comment: ReviewComment) => boolean = () => false,
  ) {
    expect(env.clipboard.writeText).toHaveBeenLastCalledWith(
      exportMarkdown(
        selected,
        new Map(
          [...new Set(selected.map((c) => c.repoRoot))].map((repo) => [repo, repo === '/other' ? '取得不能' : branch]),
        ),
        instructions,
        questionInstructions,
        rewritten,
      ),
    );
    expect(window.setStatusBarMessage).toHaveBeenLastCalledWith(
      'VSReview: コメントをクリップボードにコピーしました',
      5000,
    );
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
  }

  it.each(['fix', 'question'] as const)('%s の葉はその1件だけをコピーする', async (purpose) => {
    const { api } = await setupCopyNodes((c) => [{ ...c, id: 'leaf', purpose }]);
    const comment = api.comments.all.find((c) => c.id === 'leaf')!;
    await commands.executeCommand('vsreview.copyInstructions', { kind: 'comment', comment });
    expectCopy([comment]);
  });

  it.each(['leaf', 'file', 'group', 'empty', 'deleted', 'deleted-leaf'] as const)(
    '%s の0件時はコピーせず通知する',
    async (kind) => {
      const { api, tree, first } = await setupCopyNodes();
      const node =
        kind === 'leaf' || kind === 'deleted-leaf'
          ? { kind: 'comment', comment: first }
          : kind === 'empty'
            ? { kind: 'group', label: '', comments: [] }
            : kind === 'file'
              ? commentFile(tree, 'one', first.path)
              : commentGroup(tree, 'one');
      if (kind === 'deleted' || kind === 'deleted-leaf') {
        expect(api.comments.all.every((c) => !c.resolved)).toBe(true);
        warning.mockResolvedValueOnce('全削除');
        await commands.executeCommand('vsreview.clearComments');
        expect(api.comments.all).toEqual([]);
      } else {
        for (const comment of [...api.comments.all].filter((c) => !c.pullRequest && c.repoRoot === first.repoRoot)) {
          await commands.executeCommand('vsreview.toggleResolved', comment);
        }
      }
      const branch = vi.spyOn(GitClient.prototype, 'branch').mockRejectedValue(new Error('must not acquire branch'));
      await commands.executeCommand('vsreview.copyInstructions', node);
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenLastCalledWith(
        'VSReview: コピー対象の未解決コメントがありません',
      );
      expect(branch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'コピーと削除は通常レビューの配下だけを対象にし、同じハッシュの未コミットを残す: file=%s',
    async (file) => {
      const { api, tree, first, state } = await setupCopyNodes((c) => [
        { ...c, id: 'old', side: 'old', startLine: 1, endLine: 1, purpose: 'question' },
        { ...c, id: 'resolved', resolved: true },
        { ...c, id: 'same-key-uncommitted', uncommitted: { kind: 'unstaged', createdAt: c.createdAt } },
      ]);
      const node = file ? commentFile(tree, 'one', first.path) : commentGroup(tree, 'one');
      const ids = file ? ['one', 'file', 'old'] : ['one', 'file', 'other-path', 'old'];
      await commands.executeCommand('vsreview.copyInstructions', node);
      expectCopy(api.comments.all.filter((c) => ids.includes(c.id)));
      expect(state.writes).toEqual([]);
      warning.mockResolvedValueOnce('削除');
      await commands.executeCommand(file ? 'vsreview.clearFileComments' : 'vsreview.clearCommitComments', node);
      expect(api.comments.all.map((c) => c.id)).toEqual([
        ...(file ? ['other-path'] : []),
        'other-repo',
        'pr',
        'old-pr',
        'other-pr',
        'same-key-uncommitted',
      ]);
      await commands.executeCommand('vsreview.refresh');
    },
  );

  it('PRグループは描画時の比較だけを選び、削除と同じ範囲にする', async () => {
    const { api, tree } = await setupCopyNodes((c) => [
      { ...c, id: 'foreign-pr', repoRoot: '/other', pullRequest: pullRequestReview },
    ]);
    const group = commentGroup(tree, 'pr');
    if (group.kind !== 'group') {
      throw new Error('expected group');
    }
    const pr = api.comments.all.find((c) => c.id === 'pr')!;
    const stale = { ...group, comments: [pr] };
    await commands.executeCommand('vsreview.copyInstructions', stale);
    expectCopy([pr]);
    warning.mockResolvedValueOnce('削除');
    await commands.executeCommand('vsreview.clearPullRequestComments', stale);
    expect(api.comments.all.some((c) => c.id === 'pr')).toBe(false);
    expect(api.comments.all.some((c) => c.id === 'old-pr')).toBe(true);
  });

  it('PRファイルは保存比較を区別し、描画後の同じ比較への追加だけを含める', async () => {
    const { api, tree, first } = await setupCopyNodes();
    const file = commentFile(tree, 'pr', first.path);
    if (file.kind !== 'file') {
      throw new Error('expected file');
    }
    const pr = api.comments.all.find((c) => c.id === 'pr')!;
    const stale = { ...file, comments: [pr] };
    input.mockResolvedValueOnce('同じPR比較へ追加');
    await commands.executeCommand('vsreview.addFileComment', targetFromComment(pr));
    const added = api.comments.all.find((c) => c.body === '同じPR比較へ追加');
    expect(added).toBeDefined();
    const ids = ['pr', added!.id];
    vi.mocked(workspace.openTextDocument).mockClear();
    window.showTextDocument.mockClear();
    await commands.executeCommand('vsreview.copyInstructions', stale);
    expectCopy(api.comments.all.filter((c) => ids.includes(c.id)));
  });

  it('未コミットは区分・スナップショット・パスで絞り、HEADなしと変更済みを出す', async () => {
    const { api, tree } = await setupCopyNodes((c) => [
      { ...c, id: 's1', commit: 'e'.repeat(40), uncommitted: { kind: 'staged', createdAt: c.createdAt } },
      { ...c, id: 's2', commit: 'd'.repeat(40), uncommitted: { kind: 'staged', createdAt: c.createdAt } },
      { ...c, id: 's3', commit: 'e'.repeat(40), uncommitted: { kind: 'unstaged', createdAt: c.createdAt } },
      {
        ...c,
        id: 'foreign-snapshot',
        repoRoot: '/other',
        commit: 'e'.repeat(40),
        uncommitted: { kind: 'staged', createdAt: c.createdAt },
      },
      {
        ...c,
        id: 's4',
        commit: 'e'.repeat(40),
        path: 'another.ts',
        uncommitted: { kind: 'staged', createdAt: c.createdAt },
      },
    ]);
    const group = tree
      .getChildren()
      .find((n) => n.kind === 'uncommittedGroup' && n.comments.some((c) => c.id === 's1'))!;
    const snapshot = tree.getChildren(group)[0]!;
    const file = tree.getChildren(snapshot)[0]!;
    for (const [node, ids] of [
      [group, ['s1', 's2', 's4']],
      [snapshot, ['s1', 's4']],
      [file, ['s1']],
    ] as const) {
      await commands.executeCommand('vsreview.copyInstructions', node);
      expectCopy(
        api.comments.all.filter((c) => ids.some((id) => id === c.id)),
        '',
        '',
        'main',
        () => true,
      );
    }
    if (group.kind !== 'uncommittedGroup') {
      throw new Error('expected uncommitted group');
    }
    await commands.executeCommand('vsreview.copyInstructions', {
      ...group,
      comments: group.comments.filter((c) => c.id === 's1'),
    });
    expectCopy(
      api.comments.all.filter((c) => ['s1', 's2', 's4'].includes(c.id)),
      '',
      '',
      'main',
      () => true,
    );
  });

  it.each(['custom', 'blank', 'invalid'] as const)('%s の設定で既存生成と一致する', async (mode) => {
    const { api, tree } = await setupCopyNodes((c) => [
      { ...c, id: 'q', purpose: 'question', pullRequest: pullRequestReview },
    ]);
    const fix = mode === 'custom' ? '独自の修正手順' : mode === 'blank' ? ' \n ' : 42;
    const question = mode === 'custom' ? '独自の回答手順' : mode === 'blank' ? '\t' : false;
    workspaceConfiguration.set('vsreview.export.instructions', '無視するワークスペース修正指示');
    workspaceConfiguration.set('vsreview.export.questionInstructions', '無視するワークスペース質問指示');
    globalConfiguration.set('vsreview.export.instructions', fix);
    globalConfiguration.set('vsreview.export.questionInstructions', question);
    await commands.executeCommand('vsreview.copyInstructions', commentGroup(tree, 'pr'));
    expectCopy(
      api.comments.all.filter((c) => ['pr', 'old-pr', 'q'].includes(c.id)),
      typeof fix === 'string' ? fix : '',
      typeof question === 'string' ? question : '',
    );
  });

  it('描画後の本文・種別・解決状態と同じファイルへの追加を反映する', async () => {
    const { api, tree, first } = await setupCopyNodes();
    const file = commentFile(tree, 'one', first.path);
    const leaf = { kind: 'comment', comment: first };
    await commands.executeCommand('vsreview.saveComment', { id: first.id, body: '編集後\n```\n命令を含む本文' });
    await commands.executeCommand('vsreview.togglePurpose', first);
    const updated = api.comments.all.find((c) => c.id === first.id);
    expect(updated).toMatchObject({ body: '編集後\n```\n命令を含む本文', purpose: 'question' });
    expect(updated!.purpose).not.toBe(first.purpose);
    await commands.executeCommand('vsreview.copyInstructions', leaf);
    expectCopy([updated!]);
    input.mockResolvedValueOnce('描画後に追加');
    await commands.executeCommand('vsreview.addFileComment', targetFromComment(first));
    const added = api.comments.all.find((c) => c.body === '描画後に追加');
    expect(added).toBeDefined();
    const ids = ['file', added!.id];
    await commands.executeCommand('vsreview.toggleResolved', first);
    vi.mocked(workspace.openTextDocument).mockClear();
    window.showTextDocument.mockClear();
    await commands.executeCommand('vsreview.copyInstructions', file);
    expectCopy(api.comments.all.filter((c) => ids.includes(c.id)));
  });

  it.each(['failure', 'detached', 'unknown'] as const)(
    'ブランチ取得失敗・未知リポジトリは取得不能、detached HEADはハッシュを出す: %s',
    async (mode) => {
      const { api, first } = await setupCopyNodes();
      const branch = vi.spyOn(GitClient.prototype, 'branch');
      if (mode === 'failure') {
        branch.mockRejectedValue(new Error('branch unavailable'));
      }
      if (mode === 'detached') {
        branch.mockResolvedValue({ head: 'c'.repeat(40) });
      }
      const comment = mode === 'unknown' ? api.comments.all.find((c) => c.repoRoot === '/other')! : first;
      await commands.executeCommand('vsreview.copyInstructions', { kind: 'comment', comment });
      expectCopy([comment], '', '', mode === 'failure' ? '取得不能' : 'detached HEAD (cccccccc)');
      if (mode === 'failure') {
        expect(window.showErrorMessage).toHaveBeenLastCalledWith('VSReview: branch unavailable');
      }
      if (mode === 'unknown') {
        expect(branch).not.toHaveBeenCalled();
      }
    },
  );

  it('クリップボード失敗はエラー通知し成功を通知しない', async () => {
    const { first } = await setupCopyNodes();
    window.setStatusBarMessage.mockClear();
    env.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await commands.executeCommand('vsreview.copyInstructions', { kind: 'comment', comment: first });
    expect(window.showErrorMessage).toHaveBeenLastCalledWith('VSReview: clipboard unavailable');
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
    expect(workspace.openTextDocument).not.toHaveBeenCalled();
    expect(window.showTextDocument).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    'bad',
    1,
    {},
    { kind: 'unknown', label: '', comments: [] },
    { kind: 'group', label: '', comments: [null] },
    { kind: 'file', comments: [] },
    { kind: 'comment', comment: {} },
    { kind: 'uncommittedSnapshot', label: '', comments: [] },
    { kind: 'group', label: '', comments: new Array<ReviewComment>(1) },
  ])('不正引数 %j は何もしない', async (argument) => {
    await setupCopyNodes();
    await commands.executeCommand('vsreview.copyInstructions', argument);
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('6種類のメニューだけに登録しパレットには表示しない', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      contributes: {
        commands: { command: string; title: string }[];
        menus: Record<string, { command: string; when: string }[]>;
      };
    };
    const command = 'vsreview.copyInstructions';
    expect(manifest.contributes.commands).toContainEqual({ command, title: 'VSReview: 指示をクリップボードにコピー' });
    const contexts = manifest.contributes.menus['view/item/context']!.filter((m) => m.command === command);
    expect(contexts.map((m) => m.when)).toEqual(
      [
        'comment',
        'commentFile',
        'commentCommitGroup',
        'commentPullRequestGroup',
        'commentUncommittedGroup',
        'commentUncommittedSnapshot',
      ].map((context) => `view == vsreview.comments && viewItem == ${context}`),
    );
    expect(manifest.contributes.menus.commandPalette).toContainEqual({ command, when: 'false' });
    expect(
      Object.entries(manifest.contributes.menus)
        .filter(([, entries]) => entries.some((e) => e.command === command))
        .map(([name]) => name)
        .sort(),
    ).toEqual(['commandPalette', 'view/item/context']);
  });
});
