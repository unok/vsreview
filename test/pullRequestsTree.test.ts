import {
  archiveLease,
  reviewDocuments,
  MemoryState,
  pullRequestCommandsFor,
  pullRequest as defaultPullRequest,
  unexpectedGh,
  registerPullRequestsTree,
  reviewsFor,
  waitFor,
  accessFor,
  disposeAfter,
  repository,
  reviewComment,
  pullRequestReview,
  pullRequestRepository,
} from './fixtures';
import { runGit } from '../src/git/client';
import { documentRef } from '../src/ui/revisions';
import { parseStatusUri } from '../src/core/decorations';
import { pullRequestRemoteSetting } from '../src/ui/pullRequestSettings';
import { displayedFileTree } from '../src/ui/fileView';
import { ChangedFileNodes } from '../src/ui/changedFileNodes';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GhClient, type GhExecutor } from '../src/git/gh';
import { preparePullRequest } from '../src/git/pullRequests';
import { CommitsTree } from '../src/ui/trees';
import { ChangedFiles } from '../src/ui/repositories';
import { ReviewDiff } from '../src/ui/diff';
import { RevisionSnapshots } from '../src/ui/revisionSnapshots';
import { ReviewComments } from '../src/ui/comments';
import { deserialize } from '../src/core/model';
import { targetFromComment } from '../src/core/documents';
import { commitAll } from './gitFixtures';
import {
  window,
  workspaceConfiguration,
  globalConfiguration,
  commands,
  activateTab,
  TabInputTextDiff,
} from './vscodeMock';

async function fixture() {
  const { directory, git } = await repository();
  await writeFile(join(directory, 'file'), 'one\n');
  await commitAll(directory, 'base');
  const base = (await git.head())!;
  await writeFile(join(directory, 'file'), 'two\n');
  await commitAll(directory, 'head');
  const head = (await git.head())!;
  const pullRequest = { ...defaultPullRequest, baseRefOid: base, headRefOid: head };
  const access = await accessFor(directory);
  const changed = new ChangedFiles(access);
  const commits = new CommitsTree(() => [], access, changed);
  disposeAfter(commits);
  await commits.select(git);
  const execute = vi.fn<GhExecutor>(() => Promise.resolve(JSON.stringify([pullRequest])));
  const tree = registerPullRequestsTree(commits, changed, { gh: (root) => new GhClient(root, execute) });
  disposeAfter(tree);
  const documents = reviewDocuments(access);
  const diff = new ReviewDiff(
    documents,
    access,
    changed,
    { gh: unexpectedGh, remote: () => 'origin' },
    { review: () => undefined },
    archiveLease,
  );
  return { tree, commits, pullRequest, execute, directory, git, access, changed, documents, diff, base, head };
}
describe('pullRequestsTree', () => {
  describe('PR ツリー', () => {
    it('古い reload の reset 待ちが完了しても新しい一覧と失敗を消さない', async () => {
      const { tree, pullRequest, access, git } = await fixture();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const openTargets = vi
        .fn<() => Promise<readonly never[]>>()
        .mockImplementationOnce(async () => {
          await gate;
          return [];
        })
        .mockResolvedValue([]);
      const source = vi.fn<GhExecutor>(() => Promise.resolve(JSON.stringify([pullRequest])));
      const pendingTree = registerPullRequestsTree({ git }, new ChangedFiles(access), {
        openTargets,
        gh: (root) => new GhClient(root, source),
      });
      disposeAfter(pendingTree);
      const old = pendingTree.reload();
      await pendingTree.reload();
      const newer = await pendingTree.getChildren();
      expect(newer).toHaveLength(1);
      release();
      await old;
      expect(await pendingTree.getChildren()).toEqual(newer);
      expect(source).toHaveBeenCalledTimes(1);
      expect(await tree.getChildren()).toEqual([]);
    });
    it('PR 情報と状態装飾付きファイルを表示し、最初の差分を開く', async () => {
      const { tree, diff, documents, directory } = await fixture();
      await tree.reload();
      const node = (await tree.getChildren())[0]!;
      expect(tree.getTreeItem(node)).toMatchObject({
        label: '#12 境界値',
        description: 'main ← topic · reviewer',
        tooltip: `${defaultPullRequest.url}\n更新: ${defaultPullRequest.updatedAt}`,
      });
      const files = await tree.getChildren(node);
      expect(files[0]).toMatchObject({ kind: 'file', pullRequest: { number: 12 } });
      expect(tree.getTreeItem(files[0]!)).toMatchObject({
        contextValue: 'file',
      });
      expect(parseStatusUri(tree.getTreeItem(files[0]!).resourceUri!)).toMatchObject({ status: 'M' });
      const serialized: unknown = JSON.parse(JSON.stringify(node));
      await pullRequestCommandsFor(tree).open(serialized, diff);
      const call = commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')!;
      activateTab(new TabInputTextDiff(call[1] as vscode.Uri, call[2] as vscode.Uri));
      const opened = (await documents.openDiffs())[0]!;
      expect(opened.ref.pullRequest?.number).toBe(12);
      expect(opened.right.fsPath).toBe(join(directory, 'file'));
    });
    it('一覧の空状態と取得失敗をビュー内に表示し、更新で復旧する', async () => {
      const { tree, execute } = await fixture();
      execute.mockResolvedValueOnce('[]');
      await tree.reload();
      expect(await tree.getChildren()).toEqual([]);
      expect(tree.view.message).toContain('ありません');
      for (const message of [
        'PATH に gh 実行ファイルが見つかりません',
        'not logged in',
        'not a GitHub repository',
        'Unexpected JSON',
      ]) {
        execute.mockRejectedValueOnce(new Error(message));
        await tree.reload();
        expect(tree.view.message).toContain(message);
        expect(await tree.getChildren()).toEqual([]);
      }
      expect(window.showErrorMessage).not.toHaveBeenCalled();
      await tree.reload();
      expect((await tree.getChildren()).length).toBe(1);
    });
    it('番号を検証し、キャンセルと空入力を無視して一覧外の PR を開く', async () => {
      const { tree, execute, pullRequest, diff } = await fixture();
      await tree.reload();
      for (const input of [undefined, '', '0', '-1', '1.5', '1;echo', '99999999999999999999']) {
        window.showInputBox.mockResolvedValueOnce(input);
        await pullRequestCommandsFor(tree).openNumber(diff);
      }
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockResolvedValueOnce(JSON.stringify({ ...pullRequest, number: 30 }));
      window.showInputBox.mockResolvedValueOnce(' 30 ');
      await pullRequestCommandsFor(tree).openNumber(diff);
      expect(tree.getTreeItem((await tree.getChildren())[0]!).label).toBe('#30 境界値');
    });
    it('リポジトリ選択解除後の古い一覧応答を破棄する', async () => {
      const { tree, commits, execute, pullRequest } = await fixture();
      let finish!: (json: string) => void;
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const old = tree.reload();
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await commits.select(undefined);
      await tree.reload();
      finish(JSON.stringify([pullRequest]));
      await old;
      expect(await tree.getChildren()).toEqual([]);
      expect(tree.view.message).toContain('リポジトリを選択');
    });
    it('比較の左辺を保持し、同じ head のコミット差分と分離する', async () => {
      const { git, pullRequest, directory, access, changed, base } = await fixture();
      await writeFile(join(directory, 'new'), 'first\n');
      await commitAll(directory, 'middle');
      const head = (await git.head())!;
      await writeFile(join(directory, 'file'), 'three\n');
      await writeFile(join(directory, 'new'), 'second\n');
      await commitAll(directory, 'third');
      const latest = (await git.head())!;
      const target = await preparePullRequest(git, { ...pullRequest, headRefOid: latest }, 'origin');
      const actual = (await git.log(0, 1))[0]!;
      expect(actual.parents[0]).toBe(head);
      const snapshots = new RevisionSnapshots(access, changed);
      const snapshot = await snapshots.get(target, { refresh: true });
      expect(snapshot.target.parent).toBe(base);
      expect(snapshot.target.pullRequest?.number).toBe(12);
      const commitSnapshot = await snapshots.get({ repo: directory, commit: actual, parent: head });
      expect(commitSnapshot.target.parent).toBe(head);
      expect(commitSnapshot.target.pullRequest).toBeUndefined();
      expect(snapshot.changes.new.get('new')?.status).toBe('A');
      expect(commitSnapshot.changes.new.get('new')?.status).toBe('M');
      // base が head の途中まで進んだ場合も同じ右辺の古い比較を再利用しない。
      const advanced = await preparePullRequest(
        git,
        { ...pullRequest, baseRefOid: head, headRefOid: latest },
        'origin',
      );
      expect(advanced.parent).toBe(head);
      expect((await snapshots.get(advanced)).target.parent).toBe(head);

      expect(
        targetFromComment({
          ...reviewComment,
          repoRoot: directory,
          commit: latest,
          parent: base,
          pullRequest: { ...pullRequest, headRefOid: latest, mergeBase: target.parent },
        }).pullRequest,
      ).toMatchObject({ number: 12, headRefOid: latest, mergeBase: base });
    });
    it('入れ子のファイルに tree と list の共通設定を適用する', async () => {
      const { tree, git, directory, execute, pullRequest } = await fixture();
      await mkdir(join(directory, 'nested'));
      await writeFile(join(directory, 'nested/file'), 'nested');
      await commitAll(directory, 'nested');
      execute.mockResolvedValue(JSON.stringify([{ ...pullRequest, headRefOid: (await git.head())! }]));
      workspaceConfiguration.set('vsreview.fileView', 'list');
      await tree.reload();
      const listed = await tree.getChildren((await tree.getChildren())[0]);
      expect(listed.map((node) => node.kind === 'file' && node.file.path)).toEqual(['file', 'nested/file']);
      workspaceConfiguration.set('vsreview.fileView', 'tree');
      const nested = (await tree.getChildren((await tree.getChildren())[0])).find((node) => node.kind === 'folder');
      expect(nested).toMatchObject({ kind: 'folder', folder: { path: 'nested' } });
      expect(await tree.getChildren(nested)).toMatchObject([{ kind: 'file', file: { path: 'nested/file' } }]);
      await tree.reload();
      expect(await tree.getChildren(nested)).toEqual([]);
    });
  });

  describe('PR ツリーの失敗経路', () => {
    it('番号指定の gh 失敗はビューと通知に理由を表示する', async () => {
      const { tree, diff, execute } = await fixture();
      await tree.reload();
      for (const message of ['gh 未導入', '未認証', 'JSON 不正']) {
        window.showInputBox.mockResolvedValueOnce('12');
        execute.mockRejectedValueOnce(new Error(message));
        await pullRequestCommandsFor(tree).openNumber(diff);
        expect(tree.view.message).toBe(message);
        expect(window.showErrorMessage).toHaveBeenLastCalledWith(`VSReview: ${message}`);
      }
    });
    it('展開の Git 失敗を通知し、成功した再展開でメッセージを消す', async () => {
      const { tree, changed } = await fixture();
      await tree.reload();
      const node = (await tree.getChildren())[0]!;
      vi.spyOn(changed, 'get').mockRejectedValueOnce(new Error('diff failed'));
      expect(await tree.getChildren(node)).toEqual([]);
      expect(tree.view.message).toBe('diff failed');
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: diff failed');
      tree.rerender();
      expect(await tree.getChildren(node)).toEqual([]);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      view.elementCollapsed.fire({ element: node });
      expect(await tree.getChildren(node)).toHaveLength(1);
      expect(tree.view.message).toBe('');
    });
    it.each(['headRefOid', 'baseRefOid'] as const)('更新前の PR ノードは %s の変更後に開かない', async (field) => {
      const { tree, diff, execute, pullRequest, git, directory } = await fixture();
      await tree.reload();
      const node = (await tree.getChildren())[0]!;
      await writeFile(join(directory, 'file'), 'latest');
      await commitAll(directory, 'latest');
      execute.mockResolvedValueOnce(JSON.stringify([{ ...pullRequest, [field]: await git.head() }]));
      await tree.reload();
      await expect(pullRequestCommandsFor(tree).open(node, diff)).rejects.toThrow('一覧を更新');
      expect(await tree.getChildren(node)).toEqual([]);
      expect(tree.view.message).toContain('一覧を更新');
      expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
    });
    it('limit の設定を毎回読み、不正値は既定値へ戻す', async () => {
      const { tree, execute } = await fixture();
      for (const [value, expected] of [
        [3, 3],
        [1, 1],
        [2, 2],
        [1000, 1000],
        [1001, 50],
        [Number.MAX_SAFE_INTEGER, 50],
        [Number.MAX_SAFE_INTEGER + 1, 50],
        [Number.POSITIVE_INFINITY, 50],
        [0, 50],
        [-1, 50],
        ['5', 50],
        [1.5, 50],
      ] as const) {
        workspaceConfiguration.set('vsreview.pullRequests.limit', value);
        await tree.reload();
        expect(execute.mock.lastCall?.[1]).toContain(String(expected));
      }
    });
    it('リポジトリ未選択や不正引数では差分を開かない', async () => {
      const { tree, commits, diff } = await fixture();
      await commits.select(undefined);
      await tree.reload();
      await pullRequestCommandsFor(tree).openNumber(diff);
      for (const node of [null, {}, { kind: 'pullRequest' }]) {
        await pullRequestCommandsFor(tree).open(node, diff);
      }
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toEqual([]);
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('リポジトリを選択'));
    });
    it('差分が空なら空の PR と通知する', async () => {
      const { tree, execute, pullRequest, diff } = await fixture();
      execute.mockResolvedValueOnce(JSON.stringify([{ ...pullRequest, headRefOid: pullRequest.baseRefOid }]));
      await tree.reload();
      await pullRequestCommandsFor(tree).open((await tree.getChildren())[0], diff);
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('変更ファイルはありません'));
    });
  });

  describe('PR ファイルと比較の表示', () => {
    it('PR ファイルとフォルダの件数は同じ head でも merge-base ごとに分ける', () => {
      const comment = { ...reviewComment, path: 'nested/file', pullRequest: pullRequestReview };
      const nodes = new ChangedFileNodes(() => [comment, { ...reviewComment, path: comment.path, id: 'commit' }]);
      const target = targetFromComment(comment);
      const file = { ...target, kind: 'file' as const, name: 'file' };
      expect(nodes.getTreeItem(file).description).toContain('1 コメント');
      const commitFile = {
        ...targetFromComment({ ...reviewComment, path: comment.path }),
        kind: 'file' as const,
        name: 'file',
      };
      expect(nodes.getTreeItem(commitFile).description).toContain('1 コメント');
      const other = {
        ...file,
        parent: 'c'.repeat(40),
        pullRequest: { ...pullRequestReview, mergeBase: 'c'.repeat(40) },
      };
      expect(nodes.getTreeItem(other).description).toBe('old.ts');
      const folder = nodes.fileNodes(displayedFileTree([target.file], target.repo), target)[0]!;
      expect(folder.kind).toBe('folder');
      expect(nodes.getTreeItem(folder).description).toBe('1 コメント');
      expect(nodes.getTreeItem({ ...folder, parent: other.parent, pullRequest: other.pullRequest }).description).toBe(
        '',
      );
    });

    it('開いた旧比較は一覧更新後もレビュー時の表示情報を返す', async () => {
      const { commits, changed, documents, diff, pullRequest, execute, directory, git } = await fixture();
      const retained = registerPullRequestsTree(commits, changed, {
        gh: (root) => new GhClient(root, execute),
        comments: () => [],
        openTargets: async () => (await documents.openDiffs()).map(({ ref }) => ref),
      });
      disposeAfter(retained);
      await retained.reload();
      await pullRequestCommandsFor(retained).open((await retained.getChildren())[0], diff);
      const call = commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')!;
      activateTab(new TabInputTextDiff(call[1] as vscode.Uri, call[2] as vscode.Uri));
      const original = (await documents.openDiffs())[0]!.ref;
      await writeFile(join(directory, 'file'), 'new head');
      await commitAll(directory, 'advance');
      execute.mockResolvedValueOnce(
        JSON.stringify([{ ...pullRequest, headRefOid: await git.head(), title: 'new title' }]),
      );
      await retained.reload();
      expect(reviewsFor(retained).review(original)).toMatchObject({ ...pullRequest, mergeBase: original.parent });
    });

    it('番号指定の取得中にリポジトリ選択が変わったら応答を捨てる', async () => {
      const { tree, commits, diff, execute, pullRequest } = await fixture();
      await tree.reload();
      let finish!: (json: string) => void;
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      window.showInputBox.mockResolvedValueOnce('12');
      const pending = pullRequestCommandsFor(tree).openNumber(diff);
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      await commits.select(undefined);
      await tree.reload();
      finish(JSON.stringify(pullRequest));
      await pending;
      expect(await tree.getChildren()).toEqual([]);
      expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
    });

    it('リモート設定はユーザー設定だけを読み、ワークスペースの値を採用しない', () => {
      workspaceConfiguration.set('vsreview.pullRequests.remote', 'https://untrusted.example/repo');
      expect(pullRequestRemoteSetting()).toBe('origin');
      globalConfiguration.set('vsreview.pullRequests.remote', '  upstream  ');
      expect(pullRequestRemoteSetting()).toBe('upstream');
      globalConfiguration.set('vsreview.pullRequests.remote', 5);
      expect(pullRequestRemoteSetting()).toBe('origin');
    });

    it('保存コメントの差分を開く際に消えたオブジェクトを再取得する', async () => {
      const { git, directory, pullRequest, saved } = await pullRequestRepository();
      const access = await accessFor(directory, () => git);
      const documents = reviewDocuments(access);
      const diff = new ReviewDiff(
        documents,
        access,
        new ChangedFiles(access),
        {
          gh: (repo) => new GhClient(repo, () => Promise.resolve(JSON.stringify(pullRequest))),
          remote: () => 'origin',
        },
        { review: () => undefined },
        archiveLease,
      );
      expect(await git.hasCommit(saved.commit)).toBe(false);
      await diff.openDiff(targetFromComment(saved));
      expect(await git.hasCommit(saved.commit)).toBe(true);
      expect(commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')).toBeDefined();
    });

    it('PR 展開時に fetch できなければ理由を表示して空の子を返す', async () => {
      const { tree, execute, pullRequest, git } = await fixture();
      await runGit(git.root, ['remote', 'add', 'origin', git.root]);
      vi.spyOn(git, 'fetch').mockRejectedValue(new Error('fetch failed'));
      execute.mockResolvedValueOnce(JSON.stringify([{ ...pullRequest, headRefOid: 'f'.repeat(40) }]));
      await tree.reload();
      expect(await tree.getChildren((await tree.getChildren())[0])).toEqual([]);
      expect(tree.view.message).toContain('fetch failed');
      expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
    });
  });

  describe('番号指定と比較取得の再試行', () => {
    it.each([12, 30])('取得中に番号指定で取り込んだ PR #%s を古い一覧応答から守る', async (number) => {
      const { tree, diff, execute, pullRequest, git, directory } = await fixture();
      let finish!: (json: string) => void;
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = tree.reload();
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await writeFile(join(directory, 'file'), 'new head');
      await commitAll(directory, 'advance');
      const fresh = { ...pullRequest, number, headRefOid: (await git.head())!, title: 'fresh' };
      execute.mockResolvedValueOnce(JSON.stringify(fresh));
      window.showInputBox.mockResolvedValueOnce(String(number));
      await pullRequestCommandsFor(tree).openNumber(diff);
      finish(JSON.stringify(number === 12 ? [pullRequest] : []));
      await pending;
      const node = (await tree.getChildren()).find(
        (node) => node.kind === 'pullRequest' && node.pullRequest.number === number,
      )!;
      expect(tree.getTreeItem(node).label).toBe(`#${number} fresh`);
      expect(await tree.target(node as Extract<typeof node, { kind: 'pullRequest' }>)).toMatchObject({
        commit: { hash: fresh.headRefOid },
      });
      expect(tree.view.message).toBe('');
    });
    it('閉じた PR の番号指定で開いた差分にレビュー情報付きコメントを保存する', async () => {
      const { tree, diff, execute, pullRequest, documents, access } = await fixture();
      await tree.reload();
      execute.mockResolvedValueOnce(JSON.stringify({ ...pullRequest, number: 30, state: 'CLOSED' }));
      window.showInputBox.mockResolvedValueOnce('30');
      await pullRequestCommandsFor(tree).openNumber(diff);
      const call = commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')!;
      activateTab(new TabInputTextDiff(call[1] as vscode.Uri, call[2] as vscode.Uri));
      const state = new MemoryState();
      const service = new ReviewComments(state, vi.fn(), documents, access, reviewsFor(tree));
      disposeAfter(service);
      const opened = (await documents.openDiffs())[0]!.ref;
      window.showInputBox.mockResolvedValueOnce('closed PR comment');
      await service.addFileComment(opened);
      expect(deserialize(state.value)).toMatchObject([
        {
          body: 'closed PR comment',
          pullRequest: { ...pullRequest, number: 30, state: 'CLOSED', mergeBase: opened.parent },
        },
      ]);
    });
    it('閉じた空の PR も共通の通知と opened を通し、比較をキャッシュする', async () => {
      const { tree, diff, execute, pullRequest, git } = await fixture();
      await tree.reload();
      const closed = { ...pullRequest, number: 30, state: 'CLOSED' as const, headRefOid: pullRequest.baseRefOid };
      execute.mockResolvedValueOnce(JSON.stringify(closed));
      window.showInputBox.mockResolvedValueOnce('30');
      tree.view.message = 'old failure';
      await pullRequestCommandsFor(tree).openNumber(diff);
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('変更ファイルはありません'));
      expect(tree.view.message).toBe('');
      vi.spyOn(git, 'mergeBase').mockRejectedValue(new Error('must use cached target'));
      const target = await tree.target({ kind: 'pullRequest', repo: git.root, pullRequest: closed });
      expect(reviewsFor(tree).review(target)).toMatchObject({ state: 'CLOSED', mergeBase: target.parent });
    });
    it.each(['reload', 'repository'])('閉じた PR の比較取得中の %s でレビュー情報の保存を中止する', async (change) => {
      const { tree, commits, diff, execute, pullRequest, git, base } = await fixture();
      await tree.reload();
      let finish!: (base: string) => void;
      vi.spyOn(git, 'mergeBase').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      execute.mockResolvedValueOnce(JSON.stringify({ ...pullRequest, number: 30, state: 'CLOSED' }));
      window.showInputBox.mockResolvedValueOnce('30');
      const pending = pullRequestCommandsFor(tree).openNumber(diff);
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      const remember = vi.spyOn(reviewsFor(tree), 'rememberReview');
      if (change === 'reload') {
        await tree.reload();
      } else {
        await commits.select(undefined);
      }
      finish(base);
      await expect(pending).rejects.toThrow('一覧を更新');
      expect(remember).not.toHaveBeenCalled();
      expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
    });
    it('比較の左辺が消えても全ファイル追加として表示しない', async () => {
      const { git, pullRequest, access, changed } = await fixture();
      const target = await preparePullRequest(git, pullRequest);
      await expect(new RevisionSnapshots(access, changed).get({ ...target, parent: 'f'.repeat(40) })).rejects.toThrow(
        '比較の左辺',
      );
    });
    it('PR のラベルと説明から双方向制御文字と不可視文字を除く', async () => {
      const { tree, pullRequest, git } = await fixture();
      await tree.reload();
      const dirty = 'a\u202eb\u2066c\u200bd\ufeffe\u00adf\n';
      const item = tree.getTreeItem({
        kind: 'pullRequest',
        repo: git.root,
        pullRequest: {
          ...pullRequest,
          title: dirty,
          baseRefName: dirty,
          headRefName: dirty,
          author: { login: dirty },
        },
      });
      expect(item.label).toBe('#12 abcdef');
      expect(item.description).toBe('abcdef ← abcdef · abcdef');
    });
    it('番号指定で進んだ head を判定用キャッシュへ反映し通知する', async () => {
      const { tree, diff, execute, pullRequest, git, directory } = await fixture();
      await tree.reload();
      await writeFile(join(directory, 'file'), 'advance');
      await commitAll(directory, 'advance');
      const head = (await git.head())!;
      const changed = vi.fn();
      reviewsFor(tree).onDidChangeHeads(changed);
      execute.mockResolvedValueOnce(JSON.stringify({ ...pullRequest, headRefOid: head }));
      window.showInputBox.mockResolvedValueOnce('12');
      await pullRequestCommandsFor(tree).openNumber(diff);
      expect(reviewsFor(tree).latestHead(directory, 12)).toBe(head);
      expect(changed).toHaveBeenCalled();
      const opened = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
      expect(documentRef(opened[1] as vscode.Uri)?.commit.hash).toBe(head);
    });
    it.each(['CLOSED', 'MERGED'])('番号指定の %s PR は差分だけ開き、最新 head と一覧を変えない', async (state) => {
      const { tree, diff, execute, pullRequest, directory } = await fixture();
      await tree.reload();
      await waitFor(() => expect(reviewsFor(tree).latestHead(directory, 12)).toBe(pullRequest.headRefOid));
      execute.mockResolvedValueOnce(JSON.stringify({ ...pullRequest, number: 30, state }));
      window.showInputBox.mockResolvedValueOnce('30');
      await pullRequestCommandsFor(tree).openNumber(diff);
      expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual(['#12 境界値']);
      expect(reviewsFor(tree).latestHead(directory, 30)).toBeUndefined();
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toHaveLength(1);
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('閉じられています'));
    });
    it('展開失敗後にクリックで開けたら子も再表示する', async () => {
      const { tree, diff, changed } = await fixture();
      await tree.reload();
      const node = (await tree.getChildren())[0]!;
      vi.spyOn(changed, 'get').mockRejectedValueOnce(new Error('temporary failure'));
      expect(await tree.getChildren(node)).toEqual([]);
      await pullRequestCommandsFor(tree).open(node, diff);
      expect(await tree.getChildren(node)).toHaveLength(1);
      expect(tree.view.message).toBe('');
    });
    it('比較取得が一度失敗してもクリックで再試行できる', async () => {
      const { tree, diff, git } = await fixture();
      await tree.reload();
      vi.spyOn(git, 'mergeBase').mockRejectedValueOnce(new Error('temporary merge-base failure'));
      const node = (await tree.getChildren())[0]!;
      await expect(pullRequestCommandsFor(tree).open(node, diff)).rejects.toThrow('temporary merge-base failure');
      await pullRequestCommandsFor(tree).open(node, diff);
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toHaveLength(1);
    });
    it('一覧から消えた PR と別リポジトリのノードは開かない', async () => {
      const { tree, diff, execute } = await fixture();
      await tree.reload();
      const node = (await tree.getChildren())[0]!;
      await expect(pullRequestCommandsFor(tree).open({ ...node, repo: '/other' }, diff)).rejects.toThrow('一覧を更新');
      execute.mockResolvedValueOnce('[]');
      await tree.reload();
      await expect(pullRequestCommandsFor(tree).open(node, diff)).rejects.toThrow('一覧を更新');
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toEqual([]);
    });
    it.each(['fetch', 'mergeBase'] as const)('番号指定の %s に失敗したら最新 head を更新しない', async (operation) => {
      const { tree, diff, execute, pullRequest, git, directory } = await fixture();
      await tree.reload();
      await waitFor(() => expect(reviewsFor(tree).latestHead(directory, 12)).toBe(pullRequest.headRefOid));
      await runGit(git.root, ['remote', 'add', 'origin', git.root]);
      vi.spyOn(git, operation).mockRejectedValueOnce(new Error(`${operation} failed`));
      execute.mockResolvedValueOnce(
        JSON.stringify({
          ...pullRequest,
          number: 30,
          ...(operation === 'fetch' ? { headRefOid: 'f'.repeat(40) } : {}),
        }),
      );
      window.showInputBox.mockResolvedValueOnce('30');
      await expect(pullRequestCommandsFor(tree).openNumber(diff)).rejects.toThrow(`${operation} failed`);
      expect(reviewsFor(tree).latestHead(directory, 30)).toBeUndefined();
      expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toEqual([]);
    });
    it('別リポジトリのノードから子を取得しない', async () => {
      const { tree, pullRequest } = await fixture();
      await tree.reload();
      expect(await tree.getChildren({ kind: 'pullRequest', repo: '/other', pullRequest })).toEqual([]);
    });
    it('親を持たない PR の Files と PR ツリーは両方とも変更なしになる', async () => {
      const { tree, git, access, changed, execute, pullRequest } = await fixture();
      const root = (await git.log(1, 1))[0]!;
      const rootPullRequest = { ...pullRequest, baseRefOid: root.hash, headRefOid: root.hash };
      execute.mockResolvedValueOnce(JSON.stringify([rootPullRequest]));
      await tree.reload();
      expect(await tree.getChildren((await tree.getChildren())[0])).toEqual([]);
      const target = await preparePullRequest(git, rootPullRequest);
      const snapshot = await new RevisionSnapshots(access, changed).get(target);
      expect([...snapshot.changes.new]).toEqual([]);
    });
  });
});
