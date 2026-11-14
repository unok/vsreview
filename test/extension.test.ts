import { RevisionArchives } from '../src/ui/revisionArchives';
import { revisionSnapshots, accessFor } from './fixtures';
import { type ReviewComment, serialize } from '../src/core/model';
import { PullRequestReviews } from '../src/ui/pullRequestReviews';
import { revisionRef, targetFromComment } from '../src/core/documents';
import { GhClient } from '../src/git/gh';
import { statusUri } from '../src/ui/decorations';
import { GitClient, runGit } from '../src/git/client';
import type * as vscode from 'vscode';
import {
  workspaceFolder,
  waitFor,
  extensionContext,
  MemoryState,
  KeyedState,
  archiveClock,
  temporaryDirectory,
  repository,
  pullRequestRepository,
  pullRequest,
} from './fixtures';
import { describe, it, expect, vi } from 'vitest';
import { writeFile, lstat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { RepositoryAccess } from '../src/ui/repositories';
import { RewrittenComments } from '../src/ui/rewritten';
import { CommitsTree, CommentsTree, type CommentNode } from '../src/ui/trees';
import { AUTO_REFRESH_DEBOUNCE_MS } from '../src/ui/autoRefresh';
import { activate } from '../src/extension';
import { commitAll } from './gitFixtures';
import { revisionUri } from '../src/ui/revisions';
import {
  workspace,
  window,
  globalConfiguration,
  workspaceConfiguration,
  workspaceFolderConfiguration,
  commands,
  editorChanged,
  documentChanged,
  configurationChanged,
  foldersChanged,
  watchers,
  controller,
  rangeProviderAssigned,
  docs,
  textDocument,
  Uri,
  TabInputTextDiff,
  TabInputText,
  activateTab,
  cancellationToken,
  tabsChanged,
  tabGroupsChanged,
  windowChanged,
  threads,
  disposedThreads,
  Range,
  CommentMode,
  pick,
  warning,
} from './vscodeMock';

describe('extension', () => {
  describe('起動と同期', () => {
    it('装飾プロバイダを登録し、拡張終了時の破棄対象にする', async () => {
      const context = extensionContext();
      const dispose = vi.fn();
      window.registerFileDecorationProvider.mockReturnValueOnce({ dispose });
      const api = (await activate(context))!;
      expect(window.registerFileDecorationProvider).toHaveBeenCalledTimes(1);
      const provider = window.registerFileDecorationProvider.mock.calls[0]![0];
      const uri = statusUri({
        repo: '/repo',
        commit: 'a'.repeat(40),
        side: 'new',
        kind: 'file',
        path: 'a.ts',
        status: 'M',
      });
      expect(provider.provideFileDecoration(uri, cancellationToken)).toMatchObject({
        badge: 'M',
        color: { id: 'gitDecoration.modifiedResourceForeground' },
      });
      expect(api.provideFileDecoration(uri)).toEqual(provider.provideFileDecoration(uri, cancellationToken));
      for (const subscription of context.subscriptions) {
        subscription.dispose();
      }
      expect(dispose).toHaveBeenCalledOnce();
    });
    it('エディタ同期の例外を通知し、次の同期を続けられる', async () => {
      const api = (await activate(extensionContext()))!;
      const refresh = vi.spyOn(api.comments, 'refresh').mockImplementationOnce(() => {
        throw new Error('refresh failed');
      });
      editorChanged.fire(undefined);
      await waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith('VSReview: refresh failed'));
      refresh.mockClear();
      editorChanged.fire(undefined);
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });
    it('展開の初期化に失敗しても差分と Files・コンテキストの同期を続ける', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file.ts'), 'old');
      await commitAll(directory, 'initial');
      const parent = (await git.head())!;
      await writeFile(join(directory, 'file.ts'), 'new');
      await commitAll(directory, 'changed');
      const target = {
        repo: directory,
        commit: (await git.log(0, 1))[0]!,
        parent,
        file: { path: 'file.ts', status: 'M' as const },
      };
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const storage = await temporaryDirectory();
      const state = new KeyedState();
      const context = extensionContext(state, { storageUri: Uri.file(storage) as vscode.Uri });
      const access = await accessFor(directory);
      const archives = RevisionArchives.create(context, access, revisionSnapshots(access));
      warning.mockResolvedValue('許可');
      const right = (await archives.uri(revisionRef(target, 'new')))!;
      expect(right.scheme).toBe('file');
      expect(state.get('vsreview.archiveContexts')).toBeDefined();
      await rm(join(storage, 'revisionArchives'), { recursive: true });
      await writeFile(join(storage, 'revisionArchives'), 'blocked');
      const api = (await activate(context))!;
      Object.assign(api.filesTree.view, { visible: true });
      const left = revisionUri(revisionRef(target, 'old'), 'old');
      activateTab(new TabInputTextDiff(left, right));
      const doc = textDocument(right, 'new');
      docs.push(doc);
      window.activeTextEditor = { document: doc } as vscode.TextEditor;
      commands.executeCommand.mockClear();
      tabsChanged.fire(undefined);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.isReviewDocument', false),
      );
      await waitFor(async () => expect(await api.filesTree.getChildren()).toHaveLength(2));
      expect((await api.resolveDocumentRef(left))?.commit.hash).toBe(target.commit.hash);
      expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`ENOTDIR: not a directory, scandir '${join(storage, 'revisionArchives')}'`),
      );
      const contextsBefore = commands.executeCommand.mock.calls.filter(([name]) => name === 'setContext').length;
      tabsChanged.fire(undefined);
      await waitFor(() =>
        expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'setContext').length).toBeGreaterThan(
          contextsBefore,
        ),
      );
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    });
    it('同期中にタブが変わったら次の周回で最新の比較とコンテキストを反映する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'same');
      await commitAll(directory, 'initial');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.isReviewDocument', false),
      );
      // 起動時の履歴更新も Files の同期を要求するため、一覧更新を完了させてから
      // このテストで扱うタブ変更の競合を作る。
      await commands.executeCommand('vsreview.refresh');
      Object.assign(api.filesTree.view, { visible: true });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const synchronize = api.filesTree.synchronize.bind(api.filesTree);
      vi.spyOn(api.filesTree, 'synchronize').mockImplementationOnce(async (options) => {
        entered = true;
        await gate;
        await synchronize(options);
      });
      commands.executeCommand.mockClear();
      editorChanged.fire(undefined);
      await waitFor(() => expect(entered).toBe(true));
      const right = Uri.file(join(directory, 'file')) as vscode.Uri;
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), right));
      window.activeTextEditor = { document: textDocument(right, 'same') } as vscode.TextEditor;
      tabsChanged.fire(undefined);
      release();
      await waitFor(() =>
        expect(
          commands.executeCommand.mock.calls.filter(
            ([name, key]) => name === 'setContext' && key === 'vsreview.isReviewDocument',
          ),
        ).toEqual([
          ['setContext', 'vsreview.isReviewDocument', false],
          ['setContext', 'vsreview.isReviewDocument', true],
        ]),
      );
      expect(await api.filesTree.getChildren()).toHaveLength(2);
    });
    it('表示切り替えコマンドと設定変更でコンテキスト・ビューを更新する', async () => {
      const api = (await activate(extensionContext()))!;
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'tree');
      const changed = vi.fn();
      api.commitsTree.onDidChangeTreeData(changed);
      await commands.executeCommand('vsreview.showFileList');
      expect(workspace.getConfiguration('vsreview').get('fileView')).toBe('list');
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'list');
      expect(changed).toHaveBeenCalled();
      commands.executeCommand.mockClear();
      await commands.executeCommand('vsreview.showFileTree');
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'tree');
      expect(workspaceConfiguration.has('vsreview.fileView')).toBe(false);
      expect(workspace.getConfiguration('vsreview').get('fileView')).toBe('tree');
      changed.mockClear();
      configurationChanged.fire({ affectsConfiguration: (key) => key === 'unrelated' });
      expect(changed).not.toHaveBeenCalled();
      configurationChanged.fire({ affectsConfiguration: (key) => key === 'explorer.compactFolders' });
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it.each(['folder', 'workspace', 'global', 'unset'])(
      '表示形式を最も具体的な既存スコープへ保存する: %s',
      async (scope) => {
        const { directory } = await repository();
        await writeFile(join(directory, 'file'), 'one');
        await commitAll(directory, 'one');
        workspace.workspaceFolders = [workspaceFolder(directory)];
        if (scope !== 'unset') {
          globalConfiguration.set('vsreview.fileView', 'tree');
        }
        if (scope === 'folder' || scope === 'workspace') {
          workspaceConfiguration.set('vsreview.fileView', 'tree');
        }
        if (scope === 'folder') {
          workspaceFolderConfiguration.set(Uri.file(directory).toString(), new Map([['vsreview.fileView', 'tree']]));
        }
        const api = (await activate(extensionContext()))!;
        await waitFor(() => expect(api.commitsTree.git?.root).toBe(directory));
        await commands.executeCommand('vsreview.showFileList');
        const target =
          scope === 'folder'
            ? workspaceFolderConfiguration.get(Uri.file(directory).toString())!
            : scope === 'workspace'
              ? workspaceConfiguration
              : globalConfiguration;
        expect(target.get('vsreview.fileView')).toBe('list');
        expect(workspace.getConfiguration('vsreview', Uri.file(directory) as vscode.Uri).get('fileView')).toBe('list');
        if (scope === 'folder') {
          expect(workspaceConfiguration.get('vsreview.fileView')).toBe('tree');
        }
        if (scope === 'folder' || scope === 'workspace') {
          expect(globalConfiguration.get('vsreview.fileView')).toBe('tree');
        }
      },
    );
    it('リポジトリ切替でフォルダごとの設定を読み、選択中のフォルダだけ更新する', async () => {
      const first = await repository();
      const second = await repository();
      for (const { directory } of [first, second]) {
        await writeFile(join(directory, 'file'), 'one');
        await commitAll(directory, 'one');
      }
      workspace.workspaceFolders = [workspaceFolder(first.directory), workspaceFolder(second.directory, 1)];
      globalConfiguration.set('vsreview.fileView', 'tree');
      const firstSettings = new Map<string, unknown>([['vsreview.fileView', 'list']]);
      const secondSettings = new Map<string, unknown>([['vsreview.fileView', 'tree']]);
      workspaceFolderConfiguration.set(Uri.file(first.directory).toString(), firstSettings);
      workspaceFolderConfiguration.set(Uri.file(second.directory).toString(), secondSettings);
      const api = (await activate(extensionContext()))!;
      await waitFor(() => expect(pick).toHaveBeenCalled());
      await api.commitsTree.select(first.git);
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'list');
      commands.executeCommand.mockClear();
      await api.commitsTree.select(second.git);
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'tree');
      await commands.executeCommand('vsreview.showFileList');
      expect(secondSettings.get('vsreview.fileView')).toBe('list');
      await commands.executeCommand('vsreview.showFileTree');
      expect(secondSettings.get('vsreview.fileView')).toBe('tree');
      expect(firstSettings.get('vsreview.fileView')).toBe('list');
      expect(globalConfiguration.get('vsreview.fileView')).toBe('tree');
    });
    it('不正なfileViewはtreeに正規化し、別セクションの同名設定を読まない', async () => {
      globalConfiguration.set('vsreview.fileView', 'invalid');
      globalConfiguration.set('explorer.fileView', 'list');
      await activate(extensionContext());
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.fileView', 'tree');
    });
    it('グループ・エディタ・タブのイベントを個別に受け、履歴の再読込でFilesを再検証する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(async () => expect(await api.commitsTree.getChildren()).toHaveLength(1));
      const root = (await api.commitsTree.getChildren())[0]!;
      const target = (await api.commitsTree.getChildren(root))[0]!;
      if (target.kind !== 'file') {
        throw new Error('missing file');
      }
      const filesView = api.filesTree.view as unknown as ReturnType<typeof window.createTreeView>;
      filesView.setVisible(true);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await waitFor(async () => expect(await api.filesTree.getChildren()).toHaveLength(2));
      for (const event of [editorChanged, tabsChanged, tabGroupsChanged]) {
        const group = window.tabGroups.activeTabGroup;
        const tab = group.activeTab;
        group.tabs = [];
        group.activeTab = undefined;
        event.fire(undefined);
        await waitFor(async () => expect(await api.filesTree.getChildren()).toEqual([]));
        group.tabs = [tab!];
        group.activeTab = tab;
        event.fire(undefined);
        await waitFor(async () => expect(await api.filesTree.getChildren()).toHaveLength(2));
      }
      const node = (await api.filesTree.getChildren((await api.filesTree.getChildren())[1]))[0]!;
      // メソッドの直接呼出しではコマンド登録漏れを検出できない。
      await commands.executeCommand('vsreview.openRevisionFile', node);
      expect(window.activeTextEditor?.document.uri.scheme).toBe('vsreview');
      commands.executeCommand.mockClear();
      editorChanged.fire(undefined);
      tabsChanged.fire(undefined);
      tabGroupsChanged.fire(undefined);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.isReviewDocument', true),
      );
      expect(
        commands.executeCommand.mock.calls.filter(
          ([name, key]) => name === 'setContext' && key === 'vsreview.isReviewDocument',
        ),
      ).toHaveLength(1);
      const log = git.log.bind(git);
      const getLog = vi
        .spyOn(GitClient.prototype, 'log')
        .mockImplementation((skip, count, rev) =>
          rev === target.commit.hash ? Promise.resolve([]) : log(skip, count, rev),
        );
      await api.commitsTree.reload();
      expect(getLog.mock.calls.filter(([, , rev]) => rev === target.commit.hash)).toEqual([]);
      expect(await api.filesTree.getChildren()).toHaveLength(2);
      await writeFile(join(directory, 'file'), 'two');
      await commitAll(directory, 'two');
      await api.commitsTree.reload();
      await waitFor(async () => {
        expect(await api.filesTree.getChildren()).toEqual([]);
        expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: コミットが存在しません');
      });
    });
    it('展開文書の警告は文書ごとに一度で、削除・許可リセットのコマンドとタブの LRU が働く', async () => {
      archiveClock();
      const { directory } = await repository();
      await writeFile(join(directory, 'file.ts'), 'one');
      await commitAll(directory, 'one');
      await writeFile(join(directory, 'file.ts'), 'two');
      await commitAll(directory, 'two');
      workspace.workspaceFolders = [workspaceFolder(directory)];
      globalConfiguration.set('vsreview.revisionArchive.maxCount', 2);
      const state = new KeyedState();
      const context = extensionContext(state, { storageUri: Uri.file(await temporaryDirectory()) as vscode.Uri });
      const execute = commands.executeCommand.getMockImplementation()!;
      commands.executeCommand.mockImplementation((name, ...args) => {
        if (name === 'vscode.diff') {
          activateTab(new TabInputTextDiff(args[0] as vscode.Uri, args[1] as vscode.Uri));
        }
        return execute(name, ...args);
      });
      const api = (await activate(context))!;
      await waitFor(async () => expect(await api.commitsTree.getChildren()).toHaveLength(2));
      const latest = (await api.commitsTree.getChildren())[0]!;
      const target = (await api.commitsTree.getChildren(latest))[0]!;
      expect(target.kind).toBe('file');
      warning.mockResolvedValue('許可');
      await commands.executeCommand('vsreview.openDiff', target);
      const input = window.tabGroups.activeTabGroup.activeTab!.input;
      if (!(input instanceof TabInputTextDiff)) {
        throw new Error('差分が開いていません');
      }
      const doc = await workspace.openTextDocument(input.original);
      expect(doc.uri.scheme).toBe('file');
      warning.mockClear();
      await documentChanged.fireAsync({ document: doc, contentChanges: [], reason: undefined });
      expect(warning).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++) {
        await documentChanged.fireAsync({
          document: doc,
          contentChanges: [
            { text: 'edited', range: new Range(0, 0, 0, 0) as vscode.Range, rangeLength: 0, rangeOffset: 0 },
          ],
          reason: undefined,
        });
      }
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('VSReview: 展開したリビジョン'), {});
      const reopened = textDocument(doc.uri, doc.getText());
      await documentChanged.fireAsync({
        document: reopened,
        contentChanges: [
          { text: 'edited', range: new Range(0, 0, 0, 0) as vscode.Range, rangeLength: 0, rangeOffset: 0 },
        ],
        reason: undefined,
      });
      expect(warning).toHaveBeenCalledTimes(2);
      await commands.executeCommand('vsreview.resetRevisionArchivePermissions');
      warning.mockResolvedValue(undefined);
      await commands.executeCommand('vsreview.clearRevisionArchives');
      await expect(lstat(doc.uri.fsPath)).resolves.toBeDefined();
      warning.mockResolvedValue('全削除');
      await commands.executeCommand('vsreview.clearRevisionArchives');
      await expect(lstat(doc.uri.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await api.resolveDocumentRef(doc.uri)).toBeUndefined();
      warning.mockResolvedValue('許可');
      await commands.executeCommand('vsreview.openDiff', target);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('過去のソース'), { modal: true }, '許可', '拒否');
      globalConfiguration.set('vsreview.revisionArchive.maxCount', 50);
      const roots: string[] = [dirname(doc.uri.fsPath)];
      for (const text of ['three', 'four', 'five']) {
        await writeFile(join(directory, 'file.ts'), text);
        await commitAll(directory, text);
        await writeFile(join(directory, 'file.ts'), 'uncommitted working tree');
        const stale = docs.findIndex((doc) => doc.uri.fsPath === join(directory, 'file.ts'));
        if (stale >= 0) {
          docs.splice(stale, 1);
        }
        await api.commitsTree.reload();
        const commit = (await api.commitsTree.getChildren()).find((node) => node.kind === 'commit')!;
        const file = (await api.commitsTree.getChildren(commit))[0]!;
        await commands.executeCommand('vsreview.openDiff', file);
        const tab = window.tabGroups.activeTabGroup.activeTab!.input;
        if (!(tab instanceof TabInputTextDiff)) {
          throw new Error('差分なし');
        }
        roots.push(dirname(tab.original.fsPath));
      }
      const active = window.tabGroups.activeTabGroup.activeTab!;
      window.tabGroups.activeTabGroup.tabs = [active];
      for (const root of roots) {
        await expect(lstat(root)).resolves.toBeDefined();
      }
      globalConfiguration.set('vsreview.revisionArchive.maxCount', 2);
      tabsChanged.fire(undefined);
      await waitFor(async () => expect(lstat(roots[0]!)).rejects.toMatchObject({ code: 'ENOENT' }));
      await expect(lstat(roots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(roots[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(roots.at(-2)!)).rejects.toMatchObject({ code: 'ENOENT' });
      const activeInput = active.input;
      expect(activeInput).toBeInstanceOf(TabInputTextDiff);
      expect((activeInput as vscode.TabInputTextDiff).modified.fsPath).not.toBe(join(directory, 'file.ts'));
      expect((activeInput as vscode.TabInputTextDiff).modified.fsPath).toContain(context.storageUri!.fsPath);
      await expect(lstat(dirname((activeInput as vscode.TabInputTextDiff).modified.fsPath))).resolves.toBeDefined();
      await expect(lstat(roots.at(-1)!)).resolves.toBeDefined();
    });
    it('壊れた保存データを通知して起動を中止する', async () => {
      const state = new MemoryState();
      state.value = 'broken json';
      expect(await activate(extensionContext(state))).toBeUndefined();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'VSReview: 保存されたレビューコメントの形式が不正です。保存内容を保護するため読み込みを中止しました',
      );
    });
    it('起動・対象切り替え・打鍵・設定変更・フォルダー削除を公開イベントで確かめる', async () => {
      const { directory } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(() => expect(watchers.some((watcher) => !watcher.disposed)).toBe(true));
      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.isReviewDocument', false);
      const root = (await api.commitsTree.getChildren())[0]!;
      const target = (await api.commitsTree.getChildren(root))[0]!;
      if (target.kind !== 'file') {
        throw new Error('missing file');
      }
      const doc = textDocument(revisionUri(target, 'new'), 'one');
      docs.push(doc);
      await window.showTextDocument(doc);
      editorChanged.fire(window.activeTextEditor);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenLastCalledWith('setContext', 'vsreview.isReviewDocument', true),
      );
      const actual = await workspace.openTextDocument(Uri.file(join(directory, 'file')) as vscode.Uri);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), actual.uri));
      const thread = controller.createCommentThread(actual.uri, new Range(0, 0, 0, 1) as vscode.Range, []);
      const view = window.createTreeView.mock.calls.find(([id]) => id === 'vsreview.comments')![1].treeDataProvider;
      const rerendered = vi.fn();
      view.onDidChangeTreeData!(rerendered);
      const countsChanged = vi.fn();
      api.commitsTree.onDidChangeTreeData(countsChanged);
      await api.comments.addRangeComment({ thread, text: 'saved comment' });
      await waitFor(() => expect(rerendered).toHaveBeenCalled());
      expect(countsChanged).toHaveBeenCalled();
      expect(api.commitsTree.getTreeItem(target).description).toBe('1 コメント');
      const saved = api.comments.all[0]!;
      rerendered.mockClear();
      countsChanged.mockClear();
      await api.comments.delete(saved);
      await waitFor(() => expect(rerendered).toHaveBeenCalled());
      expect(countsChanged).toHaveBeenCalled();
      expect(api.commitsTree.getTreeItem(target).description).toBe('');
      await api.comments.addRangeComment({ thread, text: 'saved comment' });
      const savedThread = threads.find((item) => item.comments.length && !disposedThreads.has(item))!;
      await api.comments.edit(savedThread);
      const provider = controller.commentingRangeProvider!;
      expect(await provider.provideCommentingRanges(actual, cancellationToken)).toEqual([new Range(0, 0, 0, 3)]);
      const draft = controller.createCommentThread(actual.uri, new Range(0, 0, 0, 1) as vscode.Range, []);
      const created = threads.length;
      const rendering = vi.fn();
      const state = savedThread.state;
      Object.defineProperty(savedThread, 'state', { configurable: true, get: () => state, set: rendering });
      const label = savedThread.label;
      Object.defineProperty(savedThread, 'label', { configurable: true, get: () => label, set: rendering });
      await api.comments.refresh();
      rangeProviderAssigned.mockClear();
      for (const editor of [undefined, { document: doc }, { document: actual }]) {
        window.activeTextEditor = editor as vscode.TextEditor | undefined;
        await editorChanged.fireAsync(window.activeTextEditor);
        await tabsChanged.fireAsync(undefined);
      }
      expect(await provider.provideCommentingRanges(actual, cancellationToken)).toEqual([new Range(0, 0, 0, 3)]);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'vsreview.isReviewDocument', true),
      );
      expect(rangeProviderAssigned).not.toHaveBeenCalled();
      expect(disposedThreads.has(draft)).toBe(false);
      expect(disposedThreads.has(savedThread)).toBe(false);
      expect(rendering).not.toHaveBeenCalled();
      commands.executeCommand.mockClear();
      await documentChanged.fireAsync({
        document: textDocument(Uri.file('/unrelated') as vscode.Uri, 'other'),
        contentChanges: [],
        reason: undefined,
      });
      expect(await provider.provideCommentingRanges(actual, cancellationToken)).toEqual([new Range(0, 0, 0, 3)]);
      expect(commands.executeCommand).not.toHaveBeenCalled();
      expect(rangeProviderAssigned).not.toHaveBeenCalled();
      vi.spyOn(actual, 'getText').mockReturnValue('edited');
      await documentChanged.fireAsync({ document: actual, contentChanges: [], reason: undefined });
      expect(await provider.provideCommentingRanges(actual, cancellationToken)).toEqual([]);
      expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
      expect(threads).toHaveLength(created);
      expect(disposedThreads.has(savedThread)).toBe(false);
      expect(savedThread.comments[0]?.mode).toBe(CommentMode.Editing);
      tabsChanged.fire(undefined);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenLastCalledWith('setContext', 'vsreview.isReviewDocument', true),
      );
      window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: new TabInputText(actual.uri) }] });
      tabsChanged.fire(undefined);
      await waitFor(() =>
        expect(commands.executeCommand).toHaveBeenLastCalledWith('setContext', 'vsreview.isReviewDocument', true),
      );
      countsChanged.mockClear();
      rerendered.mockClear();
      windowChanged.fire({ focused: true, active: true });
      expect(countsChanged).not.toHaveBeenCalled();
      expect(rerendered).not.toHaveBeenCalled();
      globalConfiguration.set('vsreview.autoRefresh', false);
      configurationChanged.fire({ affectsConfiguration: (section: string) => section === 'vsreview.autoRefresh' });
      await commitAll(directory, 'amended', { amend: true });
      rerendered.mockClear();
      foldersChanged.fire({ added: [], removed: [] });
      await waitFor(() => expect(rerendered).toHaveBeenCalled());
      const commentView = view as vscode.TreeDataProvider<CommentNode>;
      const groups = await commentView.getChildren();
      expect((await commentView.getTreeItem(groups![0]!)).description).toContain('書き換え済み');
      globalConfiguration.set('vsreview.autoRefresh', true);
      configurationChanged.fire({ affectsConfiguration: (section: string) => section === 'vsreview.autoRefresh' });
      const other = await repository();
      workspace.workspaceFolders = [workspaceFolder(directory), workspaceFolder(other.directory, 1)];
      const before = [...watchers];
      foldersChanged.fire({ added: [], removed: [] });
      await waitFor(() => expect(before.every((watcher) => watcher.disposed)).toBe(true));
      await waitFor(() => expect(watchers.some((watcher) => !watcher.disposed)).toBe(true));
      expect(api.commitsTree.git?.root).toBe(directory);
      expect(pick).not.toHaveBeenCalled();
      globalConfiguration.set('vsreview.autoRefresh', false);
      configurationChanged.fire({
        affectsConfiguration: (section: string) => section === 'vsreview.autoRefresh',
      });
      expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
      workspace.workspaceFolders = [];
      foldersChanged.fire({ added: [], removed: [] });
      await waitFor(() => expect(api.commitsTree.git).toBeUndefined());
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });
    it('複数リポジトリの選択を待たずAPIを返し、選択後に一覧を更新する', async () => {
      const first = await repository();
      const second = await repository();
      await writeFile(join(first.directory, 'file'), 'one');
      await commitAll(first.directory, 'one');
      workspace.workspaceFolders = [workspaceFolder(first.directory), workspaceFolder(second.directory, 1)];
      let release: (value: { root: string }) => void = () => {};
      pick.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const activated = activate(extensionContext());
      await waitFor(() => expect(pick).toHaveBeenCalled());
      let api: Awaited<ReturnType<typeof activate>>;
      void activated.then((value) => {
        api = value;
      });
      await waitFor(() => expect(api).toBeDefined());
      release({ root: first.directory });
      await waitFor(() => expect(api?.commitsTree.git?.root).toBe(first.directory));
      expect(await api!.commitsTree.getChildren()).toMatchObject([{ commit: { subject: 'one' } }]);
    });
    it('起動と手動更新は検出・一覧・到達判定を二重実行しない', async () => {
      const { directory } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      workspace.workspaceFolders = [workspaceFolder(directory)];
      vi.useFakeTimers();
      const discovered = vi.spyOn(RepositoryAccess.prototype, 'discover');
      const reloaded = vi.spyOn(CommitsTree.prototype, 'reload');
      const rewritten = vi.spyOn(RewrittenComments.prototype, 'refresh');
      const api = (await activate(extensionContext()))!;
      await waitFor(() => expect(watchers.some((watcher) => !watcher.disposed)).toBe(true));
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_DEBOUNCE_MS * 2);
      expect(discovered).toHaveBeenCalledTimes(1);
      expect(reloaded).toHaveBeenCalledTimes(1);
      expect(rewritten).toHaveBeenCalledTimes(1);
      reloaded.mockClear();
      rewritten.mockClear();
      await commands.executeCommand('vsreview.refresh');
      await vi.advanceTimersByTimeAsync(AUTO_REFRESH_DEBOUNCE_MS * 2);
      expect(reloaded).toHaveBeenCalledTimes(1);
      expect(rewritten).toHaveBeenCalledTimes(1);
      expect(api.commitsTree.git?.root).toBe(directory);
    });
  });

  describe('PR の更新と自動化コマンド', () => {
    it('PR 設定変更後の一覧を新しい取得結果で描画する', async () => {
      const { directory } = await repository();
      const list = vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(async () => expect(await api.pullRequestsTree.getChildren()).toHaveLength(1));
      list.mockResolvedValue([]);
      configurationChanged.fire({ affectsConfiguration: (key: string) => key === 'vsreview.pullRequests' });
      await waitFor(() => expect(api.pullRequestsTree.view.message).toBe('開いている Pull Request はありません'));
      expect(await api.pullRequestsTree.getChildren()).toEqual([]);
    });
    it('タブイベントで直前の PR 比較を記録し、別タブへ移っても PR スレッドを保つ', async () => {
      const { source, saved, pullRequest } = await pullRequestRepository();
      vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      const comment = { ...saved, repoRoot: source, side: 'new' as const, body: 'PR only' };
      const state = new MemoryState();
      const commitComment: ReviewComment = { ...comment, id: 'commit', body: 'commit only' };
      delete commitComment.pullRequest;
      state.value = serialize([comment, commitComment]);
      workspace.workspaceFolders = [workspaceFolder(source)];
      const api = (await activate(extensionContext(state)))!;
      await waitFor(() => expect(api.commitsTree.git?.root).toBe(source));
      const target = targetFromComment(comment);
      const right = Uri.file(join(source, comment.path)) as vscode.Uri;
      const commitTarget = { ...target };
      delete commitTarget.pullRequest;
      const group = window.tabGroups.activeTabGroup;
      const commitTab = { input: new TabInputTextDiff(revisionUri(commitTarget, 'old'), right) };
      const prTab = { input: new TabInputTextDiff(revisionUri(target, 'old'), right) };
      const unrelated = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
      group.tabs = [commitTab, prTab, unrelated];
      await workspace.openTextDocument(right);
      const visible = () =>
        threads
          .filter((thread) => !disposedThreads.has(thread) && thread.uri.toString() === right.toString())
          .flatMap((thread) => thread.comments.map((comment) => comment.body));
      group.activeTab = commitTab;
      tabsChanged.fire({});
      await waitFor(() => expect(visible()).toEqual(['commit only']));
      group.activeTab = prTab;
      tabsChanged.fire({});
      await waitFor(() => expect(visible()).toEqual(['PR only']));
      const contexts = commands.executeCommand.mock.calls.filter(([name]) => name === 'setContext').length;
      group.activeTab = unrelated;
      tabsChanged.fire({});
      await waitFor(() =>
        expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'setContext').length).toBeGreaterThan(
          contexts,
        ),
      );
      expect(visible()).toEqual(['PR only']);
    });
    it('登録した両 PR コマンドから差分を開く', async () => {
      const { source, pullRequest } = await pullRequestRepository();
      vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      vi.spyOn(GhClient.prototype, 'view').mockResolvedValue(pullRequest);
      workspace.workspaceFolders = [workspaceFolder(source)];
      const api = (await activate(extensionContext()))!;
      await waitFor(async () => expect(await api.pullRequestsTree.getChildren()).toHaveLength(1));
      await commands.executeCommand('vsreview.openPullRequest', (await api.pullRequestsTree.getChildren())[0]);
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toHaveLength(1);
      window.showInputBox.mockResolvedValueOnce('12');
      await commands.executeCommand('vsreview.openPullRequestNumber');
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toHaveLength(2);
    });
    it('一覧更新の head 通知で保存コメントの書き換え判定を更新する', async () => {
      const { source, sourceGit, base, pullRequest, saved } = await pullRequestRepository();
      const comment = { ...saved, repoRoot: source };
      const state = new MemoryState();
      state.value = serialize([comment]);
      const list = vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      const refreshHeads = vi.spyOn(PullRequestReviews.prototype, 'refreshHeads');
      workspace.workspaceFolders = [workspaceFolder(source)];
      const api = (await activate(extensionContext(state)))!;
      await waitFor(() => expect(api.pullRequestsTree.view.message).toBe(''));
      const provider = window.createTreeView.mock.calls.find(([id]) => id === 'vsreview.comments')![1].treeDataProvider;
      const commentsTree = provider as CommentsTree;
      await waitFor(() => expect(refreshHeads.mock.settledResults[0]?.type).toBe('fulfilled'));
      expect(commentsTree.getTreeItem(commentsTree.getChildren()[0]!).description).not.toContain('書き換え済み');
      await runGit(source, ['checkout', '--detach', base]);
      await writeFile(join(source, 'file'), 'replacement');
      await commitAll(source, 'force');
      const latest = (await sourceGit.head())!;
      list.mockResolvedValue([{ ...pullRequest, headRefOid: latest }]);
      await commands.executeCommand('vsreview.refreshPullRequests');
      await waitFor(() =>
        expect(commentsTree.getTreeItem(commentsTree.getChildren()[0]!).description).toContain('書き換え済み'),
      );
    });
    it('コマンドで正しい PR の質問要求を受け付けて出力する', async () => {
      const { source, saved, pullRequest } = await pullRequestRepository();
      vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      const comment = { ...saved, repoRoot: source };
      const state = new MemoryState();
      const question = { ...comment, id: 'question', purpose: 'question' as const };
      state.value = serialize([comment, question]);
      workspace.workspaceFolders = [workspaceFolder(source)];
      const api = (await activate(extensionContext(state)))!;
      await waitFor(() => expect(api.pullRequestsTree.view.message).toBe(''));
      await commands.executeCommand('vsreview.exportComments', {
        scope: 'pullRequest',
        pullRequest: 12,
        repoRoot: source,
        format: 'json',
        purpose: 'question',
      });
      expect(JSON.parse(docs.at(-1)!.getText())).toMatchObject({ purpose: 'question' });
      expect((JSON.parse(docs.at(-1)!.getText()) as { comments: unknown[] }).comments).toEqual([question]);
    });
    it('種別のない旧データは修正依頼として出力し、質問だけの出力には含めない', async () => {
      const { source, saved, pullRequest } = await pullRequestRepository();
      vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([pullRequest]);
      const legacy = Object.fromEntries(
        Object.entries({ ...saved, repoRoot: source }).filter(([key]) => key !== 'purpose'),
      );
      const state = new MemoryState();
      state.value = { version: 1, comments: [legacy] };
      workspace.workspaceFolders = [workspaceFolder(source)];
      const api = (await activate(extensionContext(state)))!;
      await waitFor(() => expect(api.pullRequestsTree.view.message).toBe(''));
      await commands.executeCommand('vsreview.exportComments', {
        scope: 'pullRequest',
        pullRequest: 12,
        repoRoot: source,
        format: 'json',
        purpose: 'question',
      });
      expect(JSON.parse(docs.at(-1)!.getText())).toMatchObject({ purpose: null, comments: [], instructions: '' });
      await commands.executeCommand('vsreview.exportComments', {
        scope: 'pullRequest',
        pullRequest: 12,
        repoRoot: source,
        format: 'json',
        purpose: 'fix',
      });
      expect(JSON.parse(docs.at(-1)!.getText())).toMatchObject({ purpose: 'fix' });
      expect((JSON.parse(docs.at(-1)!.getText()) as { comments: unknown[] }).comments).toEqual([
        { ...legacy, purpose: 'fix' },
      ]);
    });
    it('PR 設定変更の再読込に失敗したら理由を通知する', async () => {
      const { directory } = await repository();
      vi.spyOn(GhClient.prototype, 'list').mockResolvedValue([]);
      workspace.workspaceFolders = [workspaceFolder(directory)];
      const api = (await activate(extensionContext()))!;
      await waitFor(() => expect(api.pullRequestsTree.view.message).toBe('開いている Pull Request はありません'));
      vi.spyOn(api.pullRequestsTree, 'reload').mockRejectedValueOnce(new Error('reload failed'));
      configurationChanged.fire({ affectsConfiguration: (key: string) => key === 'vsreview.pullRequests' });
      await waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: reload failed'));
    });
  });
});
