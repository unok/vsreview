import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import manifest from '../package.json';
import type { CommitTarget } from '../src/core/documents';
import type { ChangedFile } from '../src/core/gitParsing';
import { PULL_REQUEST_REOPEN } from '../src/core/pullRequests';
import { runGit } from '../src/git/client';
import { ExplanationStore } from '../src/git/explanationStore';
import { ExplanationCommands, REGENERATE_EXPLANATION } from '../src/ui/explanationCommands';
import { RESET_EXPLANATION_PERMISSIONS_TITLE, ReviewExplanations } from '../src/ui/explanations';
import { PullRequestsTree } from '../src/ui/pullRequests';
import type { PullRequestReviews } from '../src/ui/pullRequestReviews';
import { explanationPermissionKey } from '../src/ui/explanationPermissions';
import { ChangedFiles } from '../src/ui/repositories';
import { CommitsTree } from '../src/ui/trees';
import { ChangedFileNodes, EXPLAINED_LABEL } from '../src/ui/changedFileNodes';
import { activate } from '../src/extension';
import {
  accessFor,
  extensionContext,
  KeyedState,
  pullRequest,
  repository,
  reviewComment,
  temporaryDirectory,
  waitFor,
  workspaceFolder,
} from './fixtures';
import { commitAll } from './gitFixtures';
import { commands, globalConfiguration, warning, window, workspace } from './vscodeMock';

async function fixture(options: { has?: boolean; generating?: boolean } = {}) {
  const { directory, git } = await repository();
  await writeFile(join(directory, 'a.ts'), 'base\n');
  await commitAll(directory, 'base');
  await writeFile(join(directory, 'a.ts'), 'changed\n');
  await commitAll(directory, 'target');
  const commit = (await git.log(0, 1))[0]!;
  const access = await accessFor(directory);
  const changedFiles = new ChangedFiles(access);
  const commitsTree = new CommitsTree(() => [], access, changedFiles);
  const explanations = {
    generate: vi.fn<(target: CommitTarget, files: readonly ChangedFile[]) => Promise<void>>(() => Promise.resolve()),
    has: vi.fn<(target: CommitTarget) => boolean>(() => options.has ?? false),
    isGenerating: vi.fn(() => options.generating ?? false),
    ensureLoaded: vi.fn<(repo: string) => Promise<void>>(() => Promise.resolve()),
  };
  const pullRequestsTree = { target: vi.fn<() => Promise<CommitTarget>>() };
  const explanationCommands = new ExplanationCommands({
    access,
    changedFiles,
    commitsTree,
    pullRequestsTree,
    explanations,
  });
  return { directory, git, commit, access, explanations, pullRequestsTree, explanationCommands };
}

describe('ExplanationCommands', () => {
  it('コミットのノードから、第1親との比較と変更ファイルで生成する', async () => {
    const { explanationCommands, explanations, git, commit } = await fixture();
    await explanationCommands.generate({ kind: 'commit', repo: git.root, commit });
    expect(explanations.generate).toHaveBeenCalledExactlyOnceWith(
      { repo: git.root, commit, parent: commit.parents[0] },
      [{ status: 'M', path: 'a.ts' }],
    );
  });

  // リポジトリが不明なことだけで弾かれるのを確かめるための、形の正しいコミット。
  const VALID_COMMIT = {
    hash: 'a'.repeat(40),
    parents: [],
    subject: 'subject',
    author: 'author',
    date: '2026-11-26T00:00:00Z',
    message: 'subject',
  };
  it.each([
    ['null', () => null],
    ['空のオブジェクト', () => ({})],
    ['ファイルのノード', (repo: string) => ({ kind: 'file', repo })],
    ['不明なリポジトリ', () => ({ kind: 'commit', repo: '/unknown', commit: { ...VALID_COMMIT } })],
    ['コミットでない値', (repo: string) => ({ kind: 'commit', repo, commit: { hash: 'x' } })],
    ['区分の種類が不正', (repo: string) => ({ kind: 'uncommittedGroup', repo, change: { kind: 'other' } })],
  ])('%s では何もしない', async (_, node) => {
    const { explanationCommands, explanations, pullRequestsTree, git } = await fixture();
    await explanationCommands.generate(node(git.root));
    expect(explanations.generate).not.toHaveBeenCalled();
    expect(pullRequestsTree.target).not.toHaveBeenCalled();
  });

  it('PR のノードは fetch と検証をした比較で生成し、PR が古ければ生成しない', async () => {
    const { explanationCommands, explanations, pullRequestsTree, git, commit } = await fixture();
    const node = { kind: 'pullRequest', repo: git.root, pullRequest };
    const target: CommitTarget = {
      repo: git.root,
      commit,
      parent: commit.parents[0]!,
      pullRequest: { number: 12, headRefOid: commit.hash, mergeBase: commit.parents[0]! },
    };
    pullRequestsTree.target.mockResolvedValueOnce(target);
    await explanationCommands.generate(node);
    expect(pullRequestsTree.target).toHaveBeenCalledWith(node);
    expect(explanations.generate).toHaveBeenCalledExactlyOnceWith(target, [{ status: 'M', path: 'a.ts' }]);
    pullRequestsTree.target.mockRejectedValueOnce(new Error(PULL_REQUEST_REOPEN));
    await expect(explanationCommands.generate(node)).rejects.toThrow(PULL_REQUEST_REOPEN);
    expect(explanations.generate).toHaveBeenCalledOnce();
  });

  it('未コミットの区分は実行時のスナップショットを取り直し、変更が消えていれば空の一覧を渡す', async () => {
    const { explanationCommands, explanations, directory, git } = await fixture();
    await writeFile(join(directory, 'a.ts'), 'working\n');
    // 表示時のスナップショットは古い値でもよい。
    const node = { kind: 'uncommittedGroup', repo: git.root, change: { kind: 'unstaged' } };
    await explanationCommands.generate(node);
    const [target, files] = explanations.generate.mock.calls[0]!;
    expect(target.uncommitted).toMatchObject({ kind: 'unstaged', head: await git.head() });
    expect(files).toEqual([{ status: 'M', path: 'a.ts' }]);
    const patch = await git.patch(target.parent, target.commit.hash, files[0]!);
    expect(patch).toContain('+working');
    await runGit(directory, ['checkout', '--', 'a.ts']);
    await explanationCommands.generate(node);
    expect(explanations.generate.mock.calls[1]![1]).toEqual([]);
  });

  it('未コミットの取得に失敗したら通知して生成しない', async () => {
    const { explanationCommands, explanations, directory, git } = await fixture();
    await rm(join(directory, '.git'), { recursive: true, force: true });
    await explanationCommands.generate({ kind: 'uncommittedGroup', repo: git.root, change: { kind: 'staged' } });
    expect(window.showErrorMessage).toHaveBeenCalled();
    expect(explanations.generate).not.toHaveBeenCalled();
  });

  it.each([
    [REGENERATE_EXPLANATION, true],
    [undefined, false],
  ])('既に解説がある比較は確認し、応答 %s で再生成するか決める', async (answer, generated) => {
    const { explanationCommands, explanations, git, commit } = await fixture({ has: true });
    warning.mockResolvedValueOnce(answer);
    await explanationCommands.generate({ kind: 'commit', repo: git.root, commit });
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('の解説を作り直しますか？差分をもう一度 AI Agent に送ります'),
      { modal: true },
      '再生成',
    );
    expect(explanations.generate).toHaveBeenCalledTimes(generated ? 1 : 0);
  });

  it('解説がない比較は確認せずに生成し、保存済みかは索引の読み込み後に生成と同じ比較で調べる', async () => {
    const { explanationCommands, explanations, git, commit } = await fixture();
    const order: string[] = [];
    explanations.ensureLoaded.mockImplementation(() => {
      order.push('ensureLoaded');
      return Promise.resolve();
    });
    explanations.has.mockImplementation(() => {
      order.push('has');
      return false;
    });
    await explanationCommands.generate({ kind: 'commit', repo: git.root, commit });
    expect(warning).not.toHaveBeenCalled();
    expect(explanations.generate).toHaveBeenCalledOnce();
    expect(explanations.ensureLoaded).toHaveBeenCalledWith(git.root);
    expect(order).toEqual(['ensureLoaded', 'has']);
    expect(explanations.has).toHaveBeenCalledWith(explanations.generate.mock.calls[0]![0]);
  });

  it('確認の表示中に同じ比較でもう一度実行しても、確認は 1 件で承認後の生成は 1 回', async () => {
    const { explanationCommands, explanations, git, commit } = await fixture({ has: true });
    let answer!: (value: string | undefined) => void;
    warning.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const node = { kind: 'commit', repo: git.root, commit };
    const first = explanationCommands.generate(node);
    const second = explanationCommands.generate(node);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer(REGENERATE_EXPLANATION);
    await Promise.all([first, second]);
    expect(warning).toHaveBeenCalledOnce();
    expect(explanations.generate).toHaveBeenCalledOnce();
    // 終わった後の実行は、改めて確認する。
    warning.mockResolvedValueOnce(undefined);
    await explanationCommands.generate(node);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(explanations.generate).toHaveBeenCalledOnce();
  });

  it('親のないルートコミットからは、空ツリーとの比較で追加ファイルを渡す', async () => {
    const { explanationCommands, explanations, git } = await fixture();
    const root = (await git.log(0, 2))[1]!;
    expect(root.parents).toEqual([]);
    await explanationCommands.generate({ kind: 'commit', repo: git.root, commit: root });
    expect(explanations.generate).toHaveBeenCalledExactlyOnceWith(
      { repo: git.root, commit: root, parent: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' },
      [{ status: 'A', path: 'a.ts' }],
    );
  });

  it('同じ比較の生成中なら確認せずに、その生成に合流する', async () => {
    const { explanationCommands, explanations, git, commit } = await fixture({ has: true, generating: true });
    await explanationCommands.generate({ kind: 'commit', repo: git.root, commit });
    expect(warning).not.toHaveBeenCalled();
    expect(explanations.generate).toHaveBeenCalledOnce();
  });

  it('索引の読み込みに失敗したら生成しない', async () => {
    const { explanationCommands, explanations, git, commit } = await fixture();
    explanations.ensureLoaded.mockRejectedValueOnce(new Error('索引を読めません'));
    await expect(explanationCommands.generate({ kind: 'commit', repo: git.root, commit })).rejects.toThrow(
      '索引を読めません',
    );
    expect(explanations.generate).not.toHaveBeenCalled();
  });

  it('索引の読み込みの完了前に実行しても、保存済みの比較では再生成を確認する', async () => {
    const { git, commit, access } = await fixture();
    const storage = await temporaryDirectory();
    const run = vi.fn(() => Promise.resolve(JSON.stringify({ files: [{ id: 'F1', markdown: '# 解説' }] })));
    const create = () =>
      new ReviewExplanations({
        access,
        store: new ExplanationStore(storage),
        permissions: { allowed: () => Promise.resolve(true), denied: () => Promise.resolve(false) },
        run,
      });
    const node = { kind: 'commit', repo: git.root, commit };
    const commandsFor = (explanations: ReviewExplanations) =>
      new ExplanationCommands({
        access,
        changedFiles: new ChangedFiles(access),
        commitsTree: new CommitsTree(() => [], access, new ChangedFiles(access)),
        pullRequestsTree: { target: vi.fn() },
        explanations,
      });
    await commandsFor(create()).generate(node);
    expect(run).toHaveBeenCalledOnce();
    // 再起動直後で、まだ load を呼んでいない状態。
    warning.mockResolvedValueOnce(undefined);
    await commandsFor(create()).generate(node);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('の解説を作り直しますか？'),
      { modal: true },
      '再生成',
    );
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('解説のコマンドの登録', () => {
  it('生成は 3 種類のノードの右クリックだけに出し、リセットはパレットから実行できる', () => {
    const contributes = manifest.contributes;
    expect(contributes.commands).toContainEqual({
      command: 'vsreview.generateExplanation',
      title: 'VSReview: 解説を生成',
    });
    expect(contributes.commands).toContainEqual({
      command: 'vsreview.resetExplanationPermissions',
      title: RESET_EXPLANATION_PERMISSIONS_TITLE,
    });
    expect(
      contributes.menus['view/item/context'].filter((entry) => entry.command === 'vsreview.generateExplanation'),
    ).toEqual([
      { command: 'vsreview.generateExplanation', when: 'view == vsreview.commits && viewItem == commit' },
      { command: 'vsreview.generateExplanation', when: 'view == vsreview.pullRequests && viewItem == pullRequest' },
      { command: 'vsreview.generateExplanation', when: 'view == vsreview.commits && viewItem == uncommittedGroup' },
    ]);
    expect(contributes.menus.commandPalette).toContainEqual({ command: 'vsreview.generateExplanation', when: 'false' });
    expect(
      contributes.menus.commandPalette.some((entry) => entry.command === 'vsreview.resetExplanationPermissions'),
    ).toBe(false);
    const locations = Object.entries(contributes.menus)
      .filter(([, entries]) => entries.some((entry) => entry.command === 'vsreview.generateExplanation'))
      .map(([name]) => name)
      .sort();
    expect(locations).toEqual(['commandPalette', 'view/item/context']);
  });

  it('起動時に保存済みの解説を読み込み、リセットのコマンドが送信の許可だけを消す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a.ts'), 'base\n');
    await commitAll(directory, 'base');
    workspace.workspaceFolders = [workspaceFolder(directory)];
    globalConfiguration.set('vsreview.autoRefresh', false);
    const load = vi.spyOn(ExplanationStore.prototype, 'load');
    const state = new KeyedState();
    await state.update(explanationPermissionKey(git.root, 'claude'), false);
    await state.update('vsreview.comments', { version: 1, comments: [] });
    const context = extensionContext(state);
    await activate(context);
    await waitFor(() => expect(load).toHaveBeenCalledWith(git.root));
    await commands.executeCommand('vsreview.resetExplanationPermissions');
    expect(state.keys()).toEqual(['vsreview.comments']);
    // 手動の更新でも索引を読み直す。
    load.mockClear();
    await commands.executeCommand('vsreview.refresh');
    expect(load).toHaveBeenCalledWith(git.root);
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
  });

  it('解説の変更で Commits と Pull Requests のツリーを描き直す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a.ts'), 'base\n');
    await commitAll(directory, 'base');
    await runGit(directory, ['commit', '--allow-empty', '-m', 'empty']);
    workspace.workspaceFolders = [workspaceFolder(directory)];
    globalConfiguration.set('vsreview.autoRefresh', false);
    const load = vi.spyOn(ExplanationStore.prototype, 'load');
    const context = extensionContext(new KeyedState());
    const api = (await activate(context))!;
    await waitFor(() => expect(load).toHaveBeenCalledWith(git.root));
    const commitsChanged = vi.fn();
    const pullRequestsChanged = vi.fn();
    api.commitsTree.onDidChangeTreeData(commitsChanged);
    api.pullRequestsTree.onDidChangeTreeData(pullRequestsChanged);
    // 変更のないコミットの生成は、ツリーを描き直す処理を他に通らず、生成の開始と終了だけを通知する。
    const empty = (await git.log(0, 1))[0]!;
    await commands.executeCommand('vsreview.generateExplanation', { kind: 'commit', repo: git.root, commit: empty });
    expect(window.showInformationMessage).toHaveBeenCalledWith('VSReview: 変更ファイルがありません');
    expect(commitsChanged).toHaveBeenCalled();
    expect(pullRequestsChanged).toHaveBeenCalled();
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }
  });
});

describe('ツリーの解説あり', () => {
  it('解説のある変更ファイルだけ、コメント件数の後ろに「解説あり」を付ける（ツリー・一覧の両方）', async () => {
    const { directory, git, commit, access } = await fixture();
    const changedFiles = new ChangedFiles(access);
    const explained = vi.fn(
      (target: CommitTarget, path: string) => target.commit.hash === commit.hash && path === 'a.ts',
    );
    const tree = new CommitsTree(() => [], access, changedFiles, undefined, explained);
    await tree.select(git);
    for (const view of ['tree', 'list']) {
      globalConfiguration.set('vsreview.fileView', view);
      const node = (await tree.getChildren()).find(
        (entry) => entry.kind === 'commit' && entry.commit.hash === commit.hash,
      )!;
      const [file] = await tree.getChildren(node);
      expect(file?.kind).toBe('file');
      expect(tree.getTreeItem(file!).description).toBe(EXPLAINED_LABEL);
    }
    expect(explained).toHaveBeenCalledWith(
      expect.objectContaining({ repo: directory, commit: expect.objectContaining({ hash: commit.hash }) as unknown }),
      'a.ts',
    );
    explained.mockReturnValue(false);
    const node = (await tree.getChildren()).find(
      (entry) => entry.kind === 'commit' && entry.commit.hash === commit.hash,
    )!;
    expect(tree.getTreeItem((await tree.getChildren(node))[0]!).description).toBe('');
  });

  it('リネーム元・コメント件数・解説ありの順に「 · 」で区切る', () => {
    const nodes = new ChangedFileNodes(
      () => [reviewComment],
      () => true,
    );
    const item = nodes.getTreeItem({
      kind: 'file',
      name: reviewComment.path,
      repo: reviewComment.repoRoot,
      commit: { hash: reviewComment.commit, parents: [], subject: '', author: '', date: '', message: '' },
      parent: reviewComment.parent,
      file: { status: 'R', path: reviewComment.path, oldPath: 'old.ts' },
    });
    expect(item.description).toBe('old.ts · 1 コメント · 解説あり');
  });
});

describe('ツリーの解説あり（PR・未コミット）', () => {
  it('PR の変更ファイルにも、PR を含む比較で判定して「解説あり」を付ける', async () => {
    const { git, commit, access } = await fixture();
    const explained = vi.fn(() => true);
    const tree = PullRequestsTree.register({ git }, new ChangedFiles(access), {
      comments: () => [],
      reviews: {} as PullRequestReviews,
      source: { gh: vi.fn(), remote: () => 'origin' },
      explained,
    });
    const target = {
      repo: git.root,
      commit,
      parent: commit.parents[0]!,
      pullRequest: { number: 12, headRefOid: commit.hash, mergeBase: commit.parents[0]! },
    };
    const item = tree.getTreeItem({ kind: 'file', name: 'a.ts', ...target, file: { status: 'M', path: 'a.ts' } });
    expect(item.description).toBe(EXPLAINED_LABEL);
    expect(explained).toHaveBeenCalledWith(expect.objectContaining({ pullRequest: target.pullRequest }), 'a.ts');
    tree.dispose();
  });

  it('未コミットの区分から生成した解説は、ツリーの同じスナップショットのファイルに「解説あり」を付ける', async () => {
    const { git, directory, access } = await fixture();
    await writeFile(join(directory, 'a.ts'), 'working\n');
    globalConfiguration.set('vsreview.fileView', 'list');
    const changedFiles = new ChangedFiles(access);
    const run = vi.fn(() => Promise.resolve(JSON.stringify({ files: [{ id: 'F1', markdown: '# 解説' }] })));
    const explanations = new ReviewExplanations({
      access,
      store: new ExplanationStore(undefined),
      permissions: { allowed: () => Promise.resolve(true), denied: () => Promise.resolve(false) },
      run,
    });
    const tree = new CommitsTree(
      () => [],
      access,
      changedFiles,
      undefined,
      (target, path) => explanations.explained(target, path),
    );
    await tree.select(git);
    const explanationCommands = new ExplanationCommands({
      access,
      changedFiles,
      commitsTree: tree,
      pullRequestsTree: { target: vi.fn() },
      explanations,
    });
    await explanationCommands.generate({ kind: 'uncommittedGroup', repo: git.root, change: { kind: 'unstaged' } });
    expect(run).toHaveBeenCalledOnce();
    const fileItem = async () => {
      const uncommitted = (await tree.getChildren()).find((node) => node.kind === 'uncommitted')!;
      const group = (await tree.getChildren(uncommitted)).find(
        (node) => node.kind === 'uncommittedGroup' && node.change.kind === 'unstaged',
      )!;
      const [file] = await tree.getChildren(group);
      return tree.getTreeItem(file!);
    };
    await fileItem();
    await waitFor(async () => expect((await fileItem()).description).toBe(EXPLAINED_LABEL));
    // スナップショットが変われば消える。
    await writeFile(join(directory, 'a.ts'), 'changed again\n');
    await tree.reload();
    expect((await fileItem()).description).toBe('');
  });
});
