import { StatusDecorationProvider } from '../src/ui/decorations';
import { ChangedFiles } from '../src/ui/repositories';
import { window, globalConfiguration, ThemeIcon, TreeItemCollapsibleState } from './vscodeMock';
import { GitClient, runGit } from '../src/git/client';
import { CommitsTree, CommentsTree, COMMIT_PAGE_SIZE } from '../src/ui/trees';
import { RewrittenComments } from '../src/ui/rewritten';
import { relativeDate } from '../src/core/presentation';
import { describe, it, expect, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  waitFor,
  repository,
  accessFor,
  disposeAfter,
  reviewComment,
  pullRequestReview,
  gitProcesses,
  workspaceFolder,
} from './fixtures';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { createUncommittedChanges } from '../src/git/uncommitted';
import type { UncommittedChanges } from '../src/core/uncommitted';

describe('trees', () => {
  it('未コミットを区分・SHA・ファイルでまとめ、日時・変更済み・抜粋とメニューを表示する', async () => {
    const { directory, git } = await repository();
    const current = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const t1 = new Date(2026, 0, 2, 3, 4, 5);
    const t2 = new Date(t1.getTime() + 500);
    const staged = {
      ...reviewComment,
      repoRoot: directory,
      uncommitted: { kind: 'staged' as const, createdAt: t2.toISOString() },
    };
    const unchanged = {
      ...staged,
      id: 'unchanged',
      commit: current.unstaged.commit.hash,
      uncommitted: { kind: 'unstaged' as const, createdAt: t1.toISOString() },
    };
    const changed = { ...unchanged, id: 'changed', commit: 'c'.repeat(40), excerpt: '' };
    const comments = [
      staged,
      unchanged,
      { ...staged, id: 'b', path: 'b.ts', uncommitted: { ...staged.uncommitted, createdAt: t1.toISOString() } },
      changed,
      { ...reviewComment, id: 'ordinary', repoRoot: directory },
    ];
    const rewritten = new RewrittenComments(
      () => Promise.resolve(comments),
      await accessFor(directory),
      { latestHead: () => undefined },
      () => Promise.resolve(current),
    );
    disposeAfter(rewritten);
    const tree = new CommentsTree(() => comments, rewritten);
    disposeAfter(tree);
    await rewritten.refresh();
    const groups = tree.getChildren();
    expect(groups.map((node) => tree.getTreeItem(node).label)).toEqual([
      `${basename(directory)} · 未コミットの変更（ステージ済み）`,
      `${basename(directory)} · 未コミットの変更（未ステージ）`,
      `${basename(directory)} · bbbbbbbb subject`,
    ]);
    expect(tree.getTreeItem(groups[0]!).contextValue).toBe('commentUncommittedGroup');
    expect(tree.getTreeItem(groups[0]!).description).toBe('2 コメント · 内容が変更済み');
    const snapshot = tree.getChildren(groups[0])[0]!;
    expect(tree.getTreeItem(snapshot)).toMatchObject({
      label: `${t1.getFullYear()}-01-02 03:04:05`,
      description: 'bbbbbbbb · 2 コメント · 内容が変更済み',
      tooltip: staged.commit,
      contextValue: 'commentUncommittedSnapshot',
    });
    const files = tree.getChildren(snapshot);
    expect(files.map((node) => tree.getTreeItem(node).label)).toEqual([reviewComment.path, 'b.ts']);
    expect(tree.getTreeItem(files[0]!).contextValue).toBe('commentFile');
    const leaf = tree.getChildren(files[0])[0]!;
    expect(tree.getTreeItem(leaf)).toMatchObject({
      description: 'new L3-L4 · 内容が変更済み',
      tooltip: `${staged.body}\n\n${staged.excerpt}`,
      command: { command: 'vsreview.openComment', arguments: [staged] },
    });
    const unstaged = tree.getChildren(groups[1]);
    expect(unstaged).toHaveLength(2);
    expect(tree.getTreeItem(unstaged[0]!).label).toBe(tree.getTreeItem(unstaged[1]!).label);
    expect(tree.getTreeItem(unstaged[0]!).description).toBe(`${unchanged.commit.slice(0, 8)} · 1 コメント`);
    expect(tree.getTreeItem(unstaged[1]!).description).toBe('cccccccc · 1 コメント · 内容が変更済み');
    const changedLeaf = tree.getChildren(tree.getChildren(unstaged[1])[0])[0]!;
    expect(tree.getTreeItem(changedLeaf).tooltip).toBe(`${changed.body}\n\n${changed.hunkHeader}\n${changed.code}`);
    expect(tree.getTreeItem({ kind: 'comment', comment: { ...changed, side: 'file' } }).tooltip).toBe(changed.body);
    expect(tree.getTreeItem({ kind: 'comment', comment: reviewComment }).tooltip).toBe(reviewComment.body);
  });
  it('不正な日時を除いて最古の日時を使い、有効な日時がなければ日時不明にする', async () => {
    const { directory } = await repository();
    const first = { ...reviewComment, repoRoot: directory, uncommitted: { kind: 'staged' as const, createdAt: 'bad' } };
    const comments = [first];
    const rewritten = new RewrittenComments(() => Promise.resolve([]), await accessFor(directory), {
      latestHead: () => undefined,
    });
    const tree = new CommentsTree(() => comments, rewritten);
    disposeAfter(rewritten);
    disposeAfter(tree);
    const label = () => tree.getTreeItem(tree.getChildren(tree.getChildren()[0])[0]!).label;
    expect(label()).toBe('日時不明');
    comments.push({
      ...first,
      id: 'valid',
      uncommitted: { ...first.uncommitted, createdAt: new Date(2026, 0, 2, 3, 4, 5).toISOString() },
    });
    expect(label()).toBe('2026-01-02 03:04:05');
  });
  it('未コミットを先頭で区分し、空グループ・ignoreを除き表示設定と件数を共有する', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'src/ui'), { recursive: true });
    await writeFile(join(directory, '.gitignore'), 'dist/\n');
    for (const name of ['a', 'b']) {
      await writeFile(join(directory, `src/ui/${name}.ts`), name);
    }
    await commitAll(directory, 'base');
    const access = await accessFor(directory);
    let comments = [reviewComment];
    const tree = new CommitsTree(() => comments, access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    expect((await tree.getChildren()).map((n) => n.kind)).toEqual(['commit']);
    await writeFile(join(directory, 'src/ui/a.ts'), 'staged');
    await runGit(directory, ['add', 'src/ui/a.ts']);
    await writeFile(join(directory, 'src/ui/b.ts'), 'unstaged');
    await writeFile(join(directory, 'src/ui/c.ts'), 'unique new');
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist/out.js'), 'ignored');
    const history = vi.fn();
    const changed = vi.fn();
    tree.onDidChangeHistory(history);
    tree.onDidChangeTreeData(changed);
    await tree.reload();
    const root = (await tree.getChildren())[0]!;
    expect(tree.getTreeItem(root).label).toBe('未コミットの変更');
    expect(tree.getTreeItem(root).contextValue).not.toBe('commit');
    const groups = await tree.getChildren(root);
    expect(groups.map((n) => tree.getTreeItem(n).label)).toEqual(['ステージ済み', '未ステージ']);
    const stagedFolders = await tree.getChildren(groups[0]);
    expect(
      (await tree.getChildren(stagedFolders[0])).map((n) => n.kind === 'file' && [n.file.path, n.file.status]),
    ).toEqual([['src/ui/a.ts', 'M']]);
    const folders = await tree.getChildren(groups[1]);
    expect(tree.getTreeItem(folders[0]!).label).toBe('src/ui');
    const files = await tree.getChildren(folders[0]);
    expect(files.map((n) => n.kind === 'file' && [n.file.path, n.file.status])).toEqual([
      ['src/ui/b.ts', 'M'],
      ['src/ui/c.ts', 'A'],
    ]);
    const file = files[0]!;
    if (file.kind !== 'file') {
      throw new Error('file expected');
    }
    comments = [
      { ...reviewComment, repoRoot: directory, commit: file.commit.hash, parent: file.parent, path: file.file.path },
    ];
    expect(tree.getTreeItem(file).description).toBe('1 コメント');
    expect(tree.getTreeItem(folders[0]!).description).toBe('1 コメント');
    expect(
      new StatusDecorationProvider().provideFileDecoration(tree.getTreeItem(files[1]!).resourceUri!),
    ).toMatchObject({ badge: 'A' });
    globalConfiguration.set('explorer.compactFolders', false);
    expect(tree.getTreeItem((await tree.getChildren(groups[1]))[0]!).label).toBe('src');
    globalConfiguration.set('vsreview.fileView', 'list');
    expect((await tree.getChildren(groups[1])).map((n) => tree.getTreeItem(n).label)).toEqual([
      'src/ui/b.ts',
      'src/ui/c.ts',
    ]);
    await runGit(directory, ['add', '-A']);
    await tree.reload();
    expect((await tree.getChildren((await tree.getChildren())[0])).map((n) => tree.getTreeItem(n).label)).toEqual([
      'ステージ済み',
    ]);
    expect(history).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('reload前の未コミットroot・group・folderは現在の子を返さない', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'src'));
    await writeFile(join(directory, 'src/a'), 'first');
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const root = (await tree.getChildren())[0]!;
    const group = (await tree.getChildren(root))[0]!;
    const folder = (await tree.getChildren(group))[0]!;
    expect((await tree.getChildren(folder)).map((node) => tree.getTreeItem(node).label)).toEqual(['a']);
    await writeFile(join(directory, 'src/a'), 'second');
    await tree.reload();
    for (const node of [root, group, folder]) {
      expect(await tree.getChildren(node)).toEqual([]);
    }
    const currentGroup = (await tree.getChildren((await tree.getChildren())[0]))[0]!;
    const currentFolder = (await tree.getChildren(currentGroup))[0]!;
    expect((await tree.getChildren(currentFolder)).map((node) => tree.getTreeItem(node).label)).toEqual(['a']);
  });
  it.each(['other repository', 'newer reload'])('refreshUncommittedは%sの現在表示を上書きしない', async (scenario) => {
    const first = await repository();
    const second = await repository();
    await writeFile(join(first.directory, 'a'), 'first');
    await writeFile(join(second.directory, 'b'), 'second');
    const access = await accessFor(first.directory);
    await access.discover([workspaceFolder(first.directory), workspaceFolder(second.directory, 1)]);
    const capture = vi.fn((git: GitClient) => createUncommittedChanges(git, '2026-11-14T00:00:00Z'));
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access), capture);
    disposeAfter(tree);
    await tree.select(first.git);
    const root = (await tree.getChildren())[0]!;
    const group = (await tree.getChildren(root))[0]!;
    const target = (await tree.getChildren(group))[0]!;
    if (root.kind !== 'uncommitted' || target.kind !== 'file') {
      throw new Error('uncommitted file expected');
    }
    let expectedRepo = first.directory;
    let expectedHash: string;
    if (scenario === 'other repository') {
      await tree.select(second.git);
      const current = (await tree.getChildren())[0]!;
      if (current.kind !== 'uncommitted') {
        throw new Error('uncommitted expected');
      }
      expectedRepo = second.directory;
      expectedHash = current.changes.unstaged.commit.hash;
      expect(await tree.refreshUncommitted(target)).toMatchObject({ repo: first.directory });
    } else {
      let release!: (changes: UncommittedChanges) => void;
      capture.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = tree.refreshUncommitted(target);
      await waitFor(() => expect(release).toBeTypeOf('function'));
      await writeFile(join(first.directory, 'a'), 'latest');
      await tree.reload();
      const current = (await tree.getChildren())[0]!;
      if (current.kind !== 'uncommitted') {
        throw new Error('uncommitted expected');
      }
      expectedHash = current.changes.unstaged.commit.hash;
      expect(expectedHash).not.toBe(root.changes.unstaged.commit.hash);
      release(root.changes);
      expect(await pending).toMatchObject({ repo: first.directory });
    }
    const current = (await tree.getChildren())[0]!;
    expect(current).toMatchObject({
      kind: 'uncommitted',
      repo: expectedRepo,
      changes: { unstaged: { commit: { hash: expectedHash } } },
    });
  });
  it('初回コミット前にも未追跡とステージ済みを表示する', async () => {
    const { directory, git } = await repository();
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await writeFile(join(directory, 'b'), 'new');
    await tree.select(git);
    expect((await tree.getChildren((await tree.getChildren())[0])).map((n) => tree.getTreeItem(n).label)).toEqual([
      '未ステージ',
    ]);
    await writeFile(join(directory, 'a'), 'staged');
    await runGit(directory, ['add', 'a']);
    await tree.reload();
    const roots = await tree.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(['uncommitted']);
    expect((await tree.getChildren(roots[0])).map((n) => tree.getTreeItem(n).label)).toEqual([
      'ステージ済み',
      '未ステージ',
    ]);
  });
  it('スナップショット失敗を通知し復旧でき、遅い結果は選択解除を上書きしない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'base');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'a'), 'changed');
    const access = await accessFor(directory);
    const capture = vi.fn((client: GitClient) => createUncommittedChanges(client, '2026-11-14T00:00:00Z'));
    capture.mockRejectedValueOnce(new Error('snapshot failed'));
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access), capture);
    disposeAfter(tree);
    await tree.select(git);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: snapshot failed');
    expect((await tree.getChildren()).map((n) => n.kind)).toEqual(['commit']);
    await tree.reload();
    expect((await tree.getChildren())[0]?.kind).toBe('uncommitted');
    const group = (await tree.getChildren((await tree.getChildren())[0]))[0]!;
    const file = (await tree.getChildren(group))[0]!;
    if (file.kind !== 'file') {
      throw new Error('file expected');
    }
    capture.mockRejectedValueOnce(new Error('selection failed'));
    expect(await tree.refreshUncommitted(file)).toBeUndefined();
    expect(window.showErrorMessage).toHaveBeenLastCalledWith('VSReview: selection failed');
    const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    let release!: (changes: UncommittedChanges) => void;
    capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = tree.reload();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await tree.select(undefined);
    release(changes);
    await pending;
    expect(await tree.getChildren()).toEqual([]);
  });
  it('履歴更新の通知から更新済みのリポジトリとコミットを参照できる', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const access = await accessFor(directory, () => git);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const observations: { git: GitClient | undefined; nodes: ReturnType<CommitsTree['getChildren']> }[] = [];
    tree.onDidChangeHistory(() => {
      observations.push({ git: tree.git, nodes: tree.getChildren() });
    });
    await tree.select(git);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.git).toBe(git);
    const node = (await observations[0]!.nodes)[0]!;
    expect(node).toMatchObject({ kind: 'commit', commit: { hash: await git.head() } });
  });
  it('履歴が同じなら再描画だけ行い、空のリポジトリへの切替と解除は通知する', async () => {
    const { directory, git } = await repository();
    const access = await accessFor(directory, () => git);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const history = vi.fn();
    const changed = vi.fn();
    tree.onDidChangeHistory(history);
    tree.onDidChangeTreeData(changed);
    await tree.reload();
    expect(history).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    await tree.select(git);
    expect(history).toHaveBeenCalledTimes(1);
    expect(await tree.getChildren()).toEqual([]);
    await tree.reload();
    expect(history).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(3);
    await tree.select(undefined);
    expect(history).toHaveBeenCalledTimes(2);
    expect(await tree.getChildren()).toEqual([]);
  });
  it('フォルダ階層とコメント合計を表示し、compact設定と一覧表示に従う', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'src/ui'), { recursive: true });
    await writeFile(join(directory, 'src/ui/a.ts'), 'a');
    await writeFile(join(directory, 'src/ui/b.ts'), 'b');
    await writeFile(join(directory, 'root'), 'r');
    await commitAll(directory, 'tree');
    const commit = (await git.log(0, 1))[0]!;
    const comment = {
      ...reviewComment,
      repoRoot: directory,
      commit: commit.hash,
      parent: await git.parent(commit),
      path: 'src/ui/a.ts',
    };
    let comments = [
      comment,
      { ...comment, id: 'two', path: 'src/ui/b.ts' },
      { ...comment, id: 'root', path: 'root' },
      { ...comment, repoRoot: '/other' },
    ];
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => comments, access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const root = (await tree.getChildren())[0]!;
    const nodes = await tree.getChildren(root);
    expect(nodes.map((n) => n.kind)).toEqual(['folder', 'file']);
    const folder = nodes[0]!;
    const item = tree.getTreeItem(folder);
    expect(item.label).toBe('src/ui');
    expect(item.tooltip).toBe('src/ui · 追加');
    expect(item.accessibilityInformation?.label).toBe('src/ui · 追加');
    expect(item.iconPath).toBe(ThemeIcon.Folder);
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(item.description).toBe('2 コメント');
    expect(tree.getTreeItem(nodes[1]!).description).toBe('1 コメント');
    const files = await tree.getChildren(folder);
    expect(files.map((n) => tree.getTreeItem(n).label)).toEqual(['a.ts', 'b.ts']);
    const provider = new StatusDecorationProvider();
    expect(provider.provideFileDecoration(item.resourceUri!)).toMatchObject({
      color: { id: 'gitDecoration.addedResourceForeground' },
    });
    expect(provider.provideFileDecoration(item.resourceUri!)).not.toHaveProperty('badge');
    for (const file of files) {
      const fileItem = tree.getTreeItem(file);
      expect(fileItem.tooltip).toBe(`${file.kind === 'file' ? file.file.path : ''} · 追加`);
      expect(fileItem.accessibilityInformation?.label).toBe(fileItem.tooltip);
      expect(fileItem.iconPath).toBe(ThemeIcon.File);
      expect(fileItem.resourceUri?.path).toMatch(/\/src\/ui\/[ab]\.ts$/);
      expect(provider.provideFileDecoration(fileItem.resourceUri!)).toMatchObject({ badge: 'A', tooltip: '追加' });
    }
    expect(tree.getTreeItem(root).iconPath).toEqual(new ThemeIcon('git-commit'));
    expect(tree.getTreeItem(root).resourceUri).toBeUndefined();
    expect(new Set([root, ...nodes, ...files].map((n) => tree.getTreeItem(n).id)).size).toBe(5);
    comments = [comment];
    expect(tree.getTreeItem(folder).description).toBe('1 コメント');
    expect(tree.getTreeItem(files[0]!).description).toBe('1 コメント');
    comments = [];
    expect(tree.getTreeItem(folder).description).toBe('');
    expect(tree.getTreeItem(files[0]!).description).toBe('');
    globalConfiguration.set('explorer.compactFolders', false);
    const expanded = (await tree.getChildren(root))[0]!;
    expect(tree.getTreeItem(expanded).label).toBe('src');
    expect(tree.getTreeItem((await tree.getChildren(expanded))[0]!).label).toBe('ui');
    globalConfiguration.set('vsreview.fileView', 'list');
    const list = await tree.getChildren(root);
    expect(list.every((n) => n.kind === 'file')).toBe(true);
    expect(list.map((n) => tree.getTreeItem(n).label)).toContain('src/ui/a.ts');
    for (const node of list) {
      expect(provider.provideFileDecoration(tree.getTreeItem(node).resourceUri!)).toMatchObject({ badge: 'A' });
    }
    const renamed = {
      kind: 'file' as const,
      name: 'src/ui/new.ts',
      repo: directory,
      commit,
      parent: await git.parent(commit),
      file: { status: 'R' as const, path: 'src/ui/new.ts', oldPath: 'old/place.ts' },
    };
    expect(tree.getTreeItem(renamed).description).toBe('old/place.ts');
    comments = [{ ...comment, path: renamed.file.path }];
    expect(tree.getTreeItem(renamed).description).toBe('old/place.ts · 1 コメント');
    expect(tree.getTreeItem(renamed).iconPath).toEqual(ThemeIcon.File);
    await tree.select(undefined);
    expect(await tree.getChildren(folder)).toEqual([]);
  });
  it('compact フォルダと展開した祖先は子孫の混在状態を変更色で表示する', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'src/ui/deep'), { recursive: true });
    await writeFile(join(directory, 'src/ui/deep/existing'), 'before');
    await commitAll(directory, 'before');
    await writeFile(join(directory, 'src/ui/deep/existing'), 'after');
    await writeFile(join(directory, 'src/ui/added'), 'new');
    await commitAll(directory, 'mixed');
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const commit = (await tree.getChildren())[0]!;
    const provider = new StatusDecorationProvider();
    const compact = (await tree.getChildren(commit))[0]!;
    const compactItem = tree.getTreeItem(compact);
    expect(compactItem.label).toBe('src/ui');
    expect(compactItem.tooltip).toBe('src/ui · 変更');
    expect(provider.provideFileDecoration(compactItem.resourceUri!)).toEqual({
      color: { id: 'gitDecoration.modifiedResourceForeground' },
    });
    globalConfiguration.set('explorer.compactFolders', false);
    const src = (await tree.getChildren(commit))[0]!;
    const ui = (await tree.getChildren(src))[0]!;
    for (const folder of [src, ui]) {
      expect(provider.provideFileDecoration(tree.getTreeItem(folder).resourceUri!)).toEqual({
        color: { id: 'gitDecoration.modifiedResourceForeground' },
      });
    }
  });
  it('同じパスの削除ファイルと追加フォルダのidは衝突しない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'before');
    await commitAll(directory, 'before');
    await rm(join(directory, 'a'));
    await mkdir(join(directory, 'a'));
    await writeFile(join(directory, 'a/b'), 'after');
    await commitAll(directory, 'after');
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const commit = (await tree.getChildren())[0]!;
    const nodes = await tree.getChildren(commit);
    expect(nodes.map((node) => node.kind)).toEqual(['folder', 'file']);
    const children = await tree.getChildren(nodes[0]);
    const ids = [commit, ...nodes, ...children].map((node) => tree.getTreeItem(node).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('完了した履歴更新だけを通知し、head取得中・log取得中に追い越された更新は通知しない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const access = await accessFor(directory, () => git);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const history = vi.fn();
    tree.onDidChangeHistory(history);
    await tree.select(git);
    expect(history).toHaveBeenCalledTimes(1);
    await tree.reload();
    expect(history).toHaveBeenCalledTimes(1);
    let releaseHead!: (head: string) => void;
    vi.spyOn(git, 'head').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHead = resolve;
        }),
    );
    const staleHead = tree.reload();
    await waitFor(() => expect(releaseHead).toBeTypeOf('function'));
    await tree.reload();
    releaseHead((await git.head())!);
    await staleHead;
    expect(history).toHaveBeenCalledTimes(1);
    await writeFile(join(directory, 'file'), 'two');
    await commitAll(directory, 'two');
    let releaseLog!: (commits: Awaited<ReturnType<typeof git.log>>) => void;
    vi.spyOn(git, 'log').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLog = resolve;
        }),
    );
    const staleLog = tree.reload();
    await waitFor(() => expect(releaseLog).toBeTypeOf('function'));
    await tree.reload();
    releaseLog([]);
    await staleLog;
    expect(history).toHaveBeenCalledTimes(2);
    expect(await tree.getChildren()).toHaveLength(2);
  });
  it('変更ファイル0件のコミットは子を持たない', async () => {
    const { directory, git } = await repository();
    await gitAsAuthor(directory, ['commit', '--allow-empty', '-m', 'empty']);
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    expect(await tree.getChildren((await tree.getChildren())[0])).toEqual([]);
  });
  it('ページ境界・一覧取得後のHEAD追加・ページの重複を扱う', async () => {
    const { directory, git } = await repository();
    for (let i = 0; i < COMMIT_PAGE_SIZE + 1; i++) {
      await writeFile(join(directory, 'file'), String(i));
      await commitAll(directory, `commit ${i}`);
    }
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const first = await tree.getChildren();
    expect(first.filter((n) => n.kind === 'commit')).toHaveLength(COMMIT_PAGE_SIZE);
    expect(first.at(-1)?.kind).toBe('more');
    await writeFile(join(directory, 'file'), 'extra');
    await commitAll(directory, 'extra');
    await Promise.all([tree.loadMore(), tree.loadMore()]);
    const nodes = await tree.getChildren();
    expect(nodes).toHaveLength(COMMIT_PAGE_SIZE + 1);
    expect(new Set(nodes.map((node) => tree.getTreeItem(node).id)).size).toBe(COMMIT_PAGE_SIZE + 1);
    const fiftieth = (await git.log(2, 1))[0]!;
    await runGit(directory, ['checkout', '--detach', fiftieth.hash]);
    await tree.select(git);
    expect(await tree.getChildren()).toHaveLength(COMMIT_PAGE_SIZE);
    expect((await tree.getChildren()).some((node) => node.kind === 'more')).toBe(false);
    await tree.select(undefined);
    expect(await tree.getChildren()).toEqual([]);
  });
  it('コミット・ファイル・コメントの階層と件数をリポジトリごとに区別する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const commit = (await git.log(0, 10))[0]!;
    const access = await accessFor(directory);
    const comment = {
      ...reviewComment,
      repoRoot: directory,
      commit: commit.hash,
      parent: await git.parent(commit),
      path: 'file',
      body: '\n\n本文',
    };
    const foreign = { ...comment, id: 'foreign', repoRoot: '/foreign' };
    const commits = new CommitsTree(() => [comment, foreign], access, new ChangedFiles(access));
    disposeAfter(commits);
    await commits.select(git);
    const root = (await commits.getChildren())[0]!;
    const files = await commits.getChildren(root);
    expect(commits.getTreeItem(files[0]!).description).toBe('1 コメント');
    expect(commits.getTreeItem(root).tooltip).toContain('one');
    const rewritten = new RewrittenComments(() => Promise.resolve([comment, foreign]), access, {
      latestHead: () => undefined,
    });
    disposeAfter(rewritten);
    const tree = new CommentsTree(() => [comment, foreign], rewritten);
    disposeAfter(tree);
    const roots = tree.getChildren();
    expect(roots).toHaveLength(2);
    const groups = tree.getChildren(roots[0]);
    expect(groups).toHaveLength(1);
    const children = tree.getChildren(groups[0]);
    expect(tree.getTreeItem(children[0]!).label).toBe('本文');
    expect(tree.getTreeItem(children[0]!).contextValue).toBe('comment');
  });
  it('Review Comments の PR グループ名から制御文字を除く', async () => {
    const access = await accessFor((await repository()).directory);
    const comment = { ...reviewComment, pullRequest: { ...pullRequestReview, title: 'a\u202eb\u200bc\ufeff' } };
    const rewritten = new RewrittenComments(() => Promise.resolve([comment]), access, { latestHead: () => undefined });
    disposeAfter(rewritten);
    const tree = new CommentsTree(() => [comment], rewritten);
    disposeAfter(tree);
    expect(tree.getTreeItem(tree.getChildren()[0]!).label).toBe('repo · PR #12 abc');
  });
  it('展開要求の前にGCで消えたコミットを空として扱う', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'initial');
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    const old = (await tree.getChildren())[0]!;
    await commitAll(directory, 'amended', { amend: true });
    await runGit(directory, ['reflog', 'expire', '--expire=now', '--all']);
    await runGit(directory, ['gc', '--prune=now']);
    expect(await tree.getChildren(old)).toEqual([]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('相対日時の境界を時刻に依存せず検証する', () => {
    expect(relativeDate('invalid')).toBe('日時不明');
    const now = Date.parse('2026-01-01T00:00:00Z');
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    for (const [seconds, label] of [
      [59, 'たった今'],
      [60, '1分前'],
      [3599, '59分前'],
      [3600, '1時間前'],
      [86399, '23時間前'],
      [86400, '1日前'],
      [-1, 'たった今'],
    ] as const) {
      expect(relativeDate(ago(seconds), now)).toBe(label);
    }
  });

  it('更新中の古い応答を捨て、ファイル取得失敗を通知する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const hash = (await git.head())!;
    let release: (value: string | undefined) => void = () => {};
    const deferred = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    class DelayedGit extends GitClient {
      override head(): Promise<string | undefined> {
        return deferred;
      }
    }
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const pending = tree.select(new DelayedGit(directory));
    await tree.select(undefined);
    release(hash);
    await pending;
    expect(await tree.getChildren()).toEqual([]);
    class FailingGit extends GitClient {
      override files(): Promise<never> {
        return Promise.reject(new Error('files failed'));
      }
    }
    const guarded = await accessFor(directory, (repo) => new FailingGit(repo));
    const failed = new CommitsTree(() => [], guarded, new ChangedFiles(guarded));
    disposeAfter(failed);
    await failed.select(guarded.client(directory));
    const node = (await failed.getChildren())[0]!;
    expect(await failed.getChildren(node)).toEqual([]);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: files failed');
  });

  it('不正な更新では選択とイベントを変えず、同じHEADではlogを取り直さない', async () => {
    const { directory } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const changed = vi.fn();
    tree.onDidChangeRepository(changed);
    const client = new GitClient(directory);
    await tree.select(client);
    expect(changed).toHaveBeenCalledTimes(1);
    const processes = gitProcesses();
    await tree.reload();
    const head = await client.head();
    expect(
      processes.mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes('log') && call[1].includes(head!)),
    ).toBe(false);
    expect((await tree.getChildren()).filter((node) => node.kind === 'commit')).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    await expect(tree.select(new GitClient('/outside'))).rejects.toThrow(
      'ワークスペース外のリポジトリは参照できません',
    );
    expect(tree.git).toBe(client);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(tree.getTreeItem({ kind: 'more' }).command?.command).toBe('vsreview.loadMore');
    const node = (await tree.getChildren())[0]!;
    if (node.kind !== 'commit') {
      throw new Error('missing commit');
    }
    expect(await tree.getChildren({ ...node, repo: '/outside' })).toEqual([]);
    expect(await tree.getChildren({ ...node, commit: { ...node.commit, hash: 'f'.repeat(40) } })).toEqual([]);
    expect(
      tree.getTreeItem({
        ...node,
        kind: 'file',
        name: 'new',
        parent: node.commit.hash,
        file: { path: 'new', oldPath: 'old', status: 'R' },
      }).label,
    ).toBe('new');
    await tree.select(undefined);
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('読み込んだページ数をHEAD更新でも保ち、古い追加ページを捨てる', async () => {
    const { directory, git } = await repository();
    for (let i = 0; i < COMMIT_PAGE_SIZE + 2; i++) {
      await writeFile(join(directory, 'file'), String(i));
      await commitAll(directory, `commit ${i}`);
    }
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    await tree.loadMore();
    await writeFile(join(directory, 'file'), 'new head');
    await commitAll(directory, 'new head');
    await tree.select(git);
    expect((await tree.getChildren()).filter((node) => node.kind === 'commit')).toHaveLength(COMMIT_PAGE_SIZE + 2);
    let release: (value: Awaited<ReturnType<GitClient['log']>>) => void = () => {};
    class DelayedGit extends GitClient {
      override log(skip: number, limit: number, revision?: string) {
        return skip
          ? new Promise<Awaited<ReturnType<GitClient['log']>>>((done) => {
              release = done;
            })
          : super.log(skip, limit, revision);
      }
    }
    await tree.select(undefined);
    await tree.select(new DelayedGit(directory));
    const pending = tree.loadMore();
    await tree.reload();
    release(await git.log(COMMIT_PAGE_SIZE, COMMIT_PAGE_SIZE + 1));
    await pending;
    expect((await tree.getChildren()).filter((node) => node.kind === 'commit')).toHaveLength(COMMIT_PAGE_SIZE + 3);
    await tree.select(undefined);
    await tree.select(new DelayedGit(directory));
    const stale = tree.loadMore();
    const stalePage = await git.log(COMMIT_PAGE_SIZE, COMMIT_PAGE_SIZE + 1);
    await writeFile(join(directory, 'file'), 'next head');
    await commitAll(directory, 'next head');
    await tree.reload();
    const fresh = await tree.getChildren();
    expect(fresh[0]).toMatchObject({ commit: { subject: 'next head' } });
    release(stalePage);
    await stale;
    expect(await tree.getChildren()).toEqual(fresh);
    expect(fresh.filter((node) => node.kind === 'commit')).toHaveLength(COMMIT_PAGE_SIZE);
  });
  it('描画では到達判定を再実行せず、書き換え済みと空白本文を表示する', async () => {
    const { directory } = await repository();
    const comment = { ...reviewComment, repoRoot: directory, body: ' \n ' };
    const processes = gitProcesses();
    const access = await accessFor(directory);
    const rewritten = new RewrittenComments(() => Promise.resolve([comment]), access, { latestHead: () => undefined });
    disposeAfter(rewritten);
    await rewritten.refresh();
    const tree = new CommentsTree(() => [comment], rewritten);
    disposeAfter(tree);
    const startsBeforeRender = processes.mock.calls.length;
    expect(startsBeforeRender).toBeGreaterThan(0);
    const root = tree.getChildren()[0]!;
    const file = tree.getChildren(root)[0]!;
    const leaf = tree.getChildren(file)[0]!;
    expect(tree.getTreeItem(root).description).toContain('書き換え済み');
    expect(tree.getTreeItem(leaf).description).toContain('書き換え済み');
    expect(tree.getTreeItem(leaf).label).toBe('コメント');
    expect(tree.getChildren(leaf)).toEqual([]);
    expect(processes.mock.calls).toHaveLength(startsBeforeRender);
  });
  it('選択中の再読込は最後に要求したリポジトリを使う', async () => {
    const first = await repository();
    const second = await repository();
    await writeFile(join(first.directory, 'file'), 'A');
    await commitAll(first.directory, 'A');
    await writeFile(join(second.directory, 'file'), 'B');
    await commitAll(second.directory, 'B');
    const access = await accessFor(first.directory);
    await access.discover([workspaceFolder(first.directory), workspaceFolder(second.directory, 1)]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class DelayedGit extends GitClient {
      override async log(skip: number, limit: number, revision?: string) {
        await gate;
        return super.log(skip, limit, revision);
      }
    }
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(first.git);
    const selection = tree.select(new DelayedGit(second.directory));
    const reload = tree.reload();
    release();
    await Promise.all([selection, reload]);
    expect(tree.git?.root).toBe(second.directory);
    expect((await tree.getChildren())[0]).toMatchObject({ commit: { subject: 'B' } });
    const stale = tree.reload();
    await tree.select(first.git);
    await stale;
    expect(tree.git?.root).toBe(first.directory);
  });
  it('再読込中のページ追加を拒否し、新HEADの続きだけを追加する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const commit = (await git.log(0, 1))[0]!;
    let revision = commit.hash;
    let release: () => void = () => {};
    let gate = Promise.resolve();
    let entered: () => void = () => {};
    let releasePage: () => void = () => {};
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const logEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    class PagedGit extends GitClient {
      override head() {
        return Promise.resolve(revision);
      }
      override async log(skip: number, limit: number, rev?: string) {
        if (skip === 0 && rev !== commit.hash) {
          entered();
          await gate;
        }
        if (skip > 0) {
          await pageGate;
        }
        return Array.from({ length: Math.min(limit, COMMIT_PAGE_SIZE + 2 - skip) }, (_, index) => ({
          ...commit,
          hash: `${rev}-${skip + index}`,
        }));
      }
    }
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(new PagedGit(directory));
    revision = 'f'.repeat(40);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = tree.reload();
    await logEntered;
    const addition = tree.loadMore();
    release();
    await refresh;
    releasePage();
    await addition;
    await tree.loadMore();
    const nodes = await tree.getChildren();
    expect(nodes).toHaveLength(COMMIT_PAGE_SIZE + 2);
    expect(new Set(nodes.map((node) => tree.getTreeItem(node).id)).size).toBe(nodes.length);
    expect(nodes.every((node) => node.kind === 'commit' && node.commit.hash.startsWith(revision))).toBe(true);
  });

  it('refreshのlog失敗後にも追加ページを再試行できる', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const commit = (await git.log(0, 1))[0]!;
    let fail = false;
    let release: (value: (typeof commit)[]) => void = () => {};
    class PagedGit extends GitClient {
      override head() {
        return Promise.resolve(fail ? 'f'.repeat(40) : commit.hash);
      }
      override log(skip: number) {
        if (fail) {
          return Promise.reject(new Error('log failed'));
        }
        return skip === 0
          ? Promise.resolve(Array.from({ length: COMMIT_PAGE_SIZE + 1 }, () => commit))
          : new Promise<(typeof commit)[]>((done) => {
              release = done;
            });
      }
    }
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    const client = new PagedGit(directory);
    await tree.select(client);
    const pending = tree.loadMore();
    fail = true;
    await expect(tree.select(client)).rejects.toThrow('log failed');
    release([]);
    await pending;
    fail = false;
    const retried = tree.loadMore();
    release([{ ...commit, hash: 'e'.repeat(40) }]);
    await retried;
    expect((await tree.getChildren()).at(-1)).toMatchObject({ commit: { hash: 'e'.repeat(40) } });
  });
  it('空リポジトリの一覧と追加読み込みは空のままGitを起動しない', async () => {
    const { directory, git } = await repository();
    const access = await accessFor(directory);
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(git);
    expect(await tree.getChildren()).toEqual([]);
    const processes = gitProcesses();
    await tree.loadMore();
    expect(await tree.getChildren()).toEqual([]);
    expect(processes).not.toHaveBeenCalled();
  });
  it('ファイル取得と到達判定が両方失敗しても空一覧と元のエラーを返す', async () => {
    const { directory } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    class FailingGit extends GitClient {
      override files(): Promise<never> {
        return Promise.reject(new Error('files failed'));
      }
      override isReachable(): Promise<never> {
        return Promise.reject(new Error('reachability failed'));
      }
    }
    const access = await accessFor(directory, (root) => new FailingGit(root));
    const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
    disposeAfter(tree);
    await tree.select(access.client(directory));
    expect(await tree.getChildren((await tree.getChildren())[0])).toEqual([]);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: files failed');
  });
  it('コメントのコミット・PR グループと配下ファイルに対応する contextValue を付ける', async () => {
    const { directory } = await repository();
    const comments = [
      { ...reviewComment, repoRoot: directory },
      { ...reviewComment, id: 'pr', repoRoot: directory, pullRequest: pullRequestReview },
    ];
    const access = await accessFor(directory);
    const rewritten = new RewrittenComments(() => Promise.resolve(comments), access, { latestHead: () => undefined });
    disposeAfter(rewritten);
    const tree = new CommentsTree(() => comments, rewritten);
    disposeAfter(tree);
    for (const [id, context] of [
      ['one', 'commentCommitGroup'],
      ['pr', 'commentPullRequestGroup'],
    ]) {
      const group = tree.getChildren().find((n) => n.kind === 'group' && n.comments.some((c) => c.id === id))!;
      expect(tree.getTreeItem(group).contextValue).toBe(context);
      const file = tree.getChildren(group).find((n) => n.kind === 'file' && n.label === reviewComment.path)!;
      expect(tree.getTreeItem(file).contextValue).toBe('commentFile');
    }
  });
});
