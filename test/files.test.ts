import {
  archiveLease,
  reviewDocuments,
  revisionSnapshots,
  unexpectedGh,
  pullRequestRepository,
  gitProcesses,
  waitFor,
  accessFor,
  disposeAfter,
  repository,
  MemoryState,
} from './fixtures';
import { preparePullRequest } from '../src/git/pullRequests';
import { StatusDecorationProvider } from '../src/ui/decorations';
import { parseStatusUri } from '../src/core/decorations';
import { ChangedFiles, type RepositoryAccess } from '../src/ui/repositories';
import { SNAPSHOT_CACHE_LIMIT } from '../src/ui/revisionSnapshots';
import { CommitsTree } from '../src/ui/trees';
import type * as vscode from 'vscode';
import { targetFromComment, type FileTarget } from '../src/core/documents';
import { runGit } from '../src/git/client';
import { ReviewDiff } from '../src/ui/diff';
import { ReviewComments } from '../src/ui/comments';
import { workingPosition } from '../src/ui/navigation';
import { describe, expect, it, vi } from 'vitest';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { ReviewDocuments } from '../src/ui/documents';
import { shortHash } from '../src/core/presentation';
import { FilesTree, type FileNode } from '../src/ui/files';
import { revisionUri, RevisionProvider } from '../src/ui/revisions';
import {
  commands,
  activateTab,
  TabInputText,
  TabInputTextDiff,
  textDocument,
  window,
  workspace,
  ThemeIcon,
  TreeItemCollapsibleState,
  controller,
  Range,
  Position,
  Uri,
} from './vscodeMock';

function filesTree(documents: ReviewDocuments, access: RepositoryAccess, changedFiles?: ChangedFiles): FilesTree {
  const tree = FilesTree.register(
    documents,
    access,
    revisionSnapshots(access, changedFiles ?? new ChangedFiles(access)),
    archiveLease,
  );
  // 初期条件だけを設定し、テストで要求する同期より先に取得を始めない。
  Object.assign(tree.view, { visible: true });
  return tree;
}

function commandCount(processes: ReturnType<typeof gitProcesses>, command: string): number {
  return processes.mock.calls.filter((call) => Array.isArray(call[1]) && call[1].includes(command)).length;
}

describe('files', () => {
  it('遅れて解決した未コミット差分は後から表示した通常差分を上書きしない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'one');
    await commitAll(directory, 'base');
    const commit = (await git.log(0, 1))[0]!;
    const target = {
      repo: directory,
      commit,
      parent: await git.parent(commit),
      file: { path: 'a', status: 'A' as const },
    };
    const access = await accessFor(directory);
    const documents = reviewDocuments(access);
    const tree = filesTree(documents, access);
    disposeAfter(tree);
    const uncommitted = {
      ...target,
      uncommitted: { kind: 'staged' as const, createdAt: '2026-11-14T00:00:00Z' },
    };
    activateTab(new TabInputTextDiff(revisionUri(uncommitted, 'old'), revisionUri(uncommitted, 'new')));
    const original = documents.openDiffs.bind(documents);
    let release!: () => void;
    vi.spyOn(documents, 'openDiffs').mockImplementationOnce(async () => {
      const diffs = await original();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return diffs;
    });
    const pending = tree.synchronize();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
    await tree.synchronize();
    expect(await tree.getChildren()).toHaveLength(2);
    expect(tree.view.message).toBe('');
    release();
    await pending;
    expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual([
      '変更前（親なし）',
      `変更後 ${shortHash(commit.hash)}`,
    ]);
    expect(tree.view.message).toBe('');
  });
  it('同じビューで通常と未コミットを切り替え、差分なしでメッセージを戻す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'one');
    await commitAll(directory, 'base');
    const commit = (await git.log(0, 1))[0]!;
    const target = {
      repo: directory,
      commit,
      parent: await git.parent(commit),
      file: { path: 'a', status: 'A' as const },
    };
    const access = await accessFor(directory);
    const tree = filesTree(reviewDocuments(access), access);
    disposeAfter(tree);
    const select = async (uncommitted: boolean) => {
      const ref = uncommitted
        ? { ...target, uncommitted: { kind: 'staged' as const, createdAt: '2026-11-14T00:00:00Z' } }
        : target;
      activateTab(new TabInputTextDiff(revisionUri(ref, 'old'), revisionUri(ref, 'new')));
      await tree.synchronize();
    };
    await select(false);
    expect(await tree.getChildren()).toHaveLength(2);
    await select(true);
    expect(await tree.getChildren()).toEqual([]);
    expect(tree.view.message).toBe('未コミットの差分は Files ビューに対応していません');
    await select(false);
    expect(await tree.getChildren()).toHaveLength(2);
    expect(tree.view.message).toBe('');
    await select(true);
    window.tabGroups.all = [];
    window.activeTextEditor = undefined;
    await tree.synchronize();
    expect(tree.view.message).toBe('差分を開くと表示します');
  });
  describe('コミットのファイル', () => {
    it('差分なしは空、深い旧・新パスを表示し、非表示中はrevealせず再表示時に選択する', async () => {
      const provider = new StatusDecorationProvider();
      const { directory, git } = await repository();
      await mkdir(join(directory, '深い 階層/sub'), { recursive: true });
      await writeFile(join(directory, '深い 階層/sub/old'), 'same');
      await commitAll(directory, 'root');
      await rename(join(directory, '深い 階層/sub/old'), join(directory, '深い 階層/sub/new'));
      await commitAll(directory, 'rename');
      const commit = (await git.log(0, 1))[0]!;
      const target = { repo: directory, commit, parent: await git.parent(commit), file: (await git.files(commit))[0]! };
      const access = await accessFor(directory);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
      expect(tree.view.message).toBe('差分を開くと表示します');
      const view = tree.view;
      const reveal = vi.spyOn(view, 'reveal');
      (view as unknown as ReturnType<typeof window.createTreeView>).setVisible(false);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await window.showTextDocument(textDocument(revisionUri(target, 'new'), 'same'));
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
      expect(reveal).not.toHaveBeenCalled();
      (view as unknown as ReturnType<typeof window.createTreeView>).setVisible(true);
      await tree.synchronize();
      const roots = await tree.getChildren();
      expect(roots.map((node) => tree.getTreeItem(node).label)).toEqual([
        `変更前 ${shortHash(target.parent)}`,
        `変更後 ${shortHash(commit.hash)}`,
      ]);
      expect(reveal).toHaveBeenLastCalledWith(expect.objectContaining({ path: '深い 階層/sub/new' }), {
        select: true,
        focus: false,
        expand: true,
      });
      for (const root of roots) {
        const rootItem = tree.getTreeItem(root);
        expect(provider.provideFileDecoration(rootItem.resourceUri!)).toMatchObject({
          color: { id: 'gitDecoration.renamedResourceForeground' },
        });
        expect(rootItem.tooltip).toBe(`${directory} · リネーム`);
        expect(rootItem.accessibilityInformation?.label).toBe(rootItem.tooltip);
      }
      const allNodes: FileNode[] = [...roots];
      for (const root of roots) {
        const folder = (await tree.getChildren(root))[0]!;
        const sub = (await tree.getChildren(folder))[0]!;
        const item = tree.getTreeItem(sub);
        expect(item.label).toBe('sub');
        expect(item.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
        expect(item.iconPath).toBe(ThemeIcon.Folder);
        expect(item.command).toBeUndefined();
        expect(provider.provideFileDecoration(item.resourceUri!)).toMatchObject({
          color: { id: 'gitDecoration.renamedResourceForeground' },
        });
        allNodes.push(folder, sub, ...(await tree.getChildren(sub)));
      }
      const ids = allNodes.map((node) => tree.getTreeItem(node).id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const node of allNodes) {
        const nodeItem = tree.getTreeItem(node);
        expect(nodeItem.tooltip).toBe(`${node.path || directory} · リネーム`);
        expect(nodeItem.accessibilityInformation?.label).toBe(nodeItem.tooltip);
        expect(nodeItem.id).toBe(ids[allNodes.indexOf(node)]);
        const parent = tree.getParent(node);
        if (parent) {
          expect(await tree.getChildren(parent)).toContain(node);
        }
      }
      const selected = reveal.mock.calls.at(-1)![0];
      let ancestor: FileNode | undefined = selected;
      for (let depth = 0; depth < 3; depth++) {
        ancestor = tree.getParent(ancestor!);
        expect(ancestor).toBeDefined();
      }
      expect(ancestor).toBe(roots[1]);
      expect(tree.getParent(ancestor!)).toBeUndefined();
      expect(tree.getTreeItem(selected).description).toContain('開いているファイル');
      expect(provider.provideFileDecoration(tree.getTreeItem(selected).resourceUri!)).toMatchObject({
        badge: 'R',
      });
      expect(tree.getTreeItem(selected).description).toBe('深い 階層/sub/old · 開いているファイル');
      await window.showTextDocument(textDocument(revisionUri(target, 'old'), 'same'));
      await tree.synchronize();
      expect(reveal).toHaveBeenLastCalledWith(expect.objectContaining({ path: '深い 階層/sub/old' }), {
        select: true,
        focus: false,
        expand: true,
      });
      const oldSelected = reveal.mock.calls.at(-1)![0];
      expect(tree.getTreeItem(oldSelected).description).toBe('深い 階層/sub/new · 開いているファイル');
      activateTab(undefined);
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
    });

    it('ルートコミットの変更前は空、追加・削除の存在しない側は選択しない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'root');
      const access = await accessFor(directory);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      for (const deleted of [false, true]) {
        if (deleted) {
          await rm(join(directory, 'file'));
          await commitAll(directory, 'delete');
        }
        const commit = (await git.log(0, 1))[0]!;
        const target = {
          repo: directory,
          commit,
          parent: await git.parent(commit),
          file: (await git.files(commit))[0]!,
        };
        activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
        await window.showTextDocument(textDocument(revisionUri(target, deleted ? 'new' : 'old'), ''));
        const reveal = vi.spyOn(tree.view, 'reveal');
        reveal.mockClear();
        await tree.synchronize();
        const roots = await tree.getChildren();
        expect(await tree.getChildren(roots[deleted ? 1 : 0])).toEqual([]);
        expect(reveal.mock.calls.some(([, options]) => options?.select)).toBe(false);
      }
    });

    it('未変更ファイルを両リビジョンの仮想文書で開き、コメントのアンカーと作業ツリー転送を保つ', async () => {
      const provider = new StatusDecorationProvider();
      const { directory, git } = await repository();
      await writeFile(join(directory, 'stable.ts'), 'const stable = 1;\n');
      await writeFile(join(directory, 'changed.ts'), 'before');
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'changed.ts'), 'after');
      await commitAll(directory, 'after');
      const commit = (await git.log(0, 1))[0]!;
      const target = { repo: directory, commit, parent: await git.parent(commit), file: (await git.files(commit))[0]! };
      const access = await accessFor(directory);
      const documents = reviewDocuments(access);
      const changedFiles = new ChangedFiles(access);
      const tree = filesTree(documents, access, changedFiles);
      disposeAfter(tree);
      disposeAfter(workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)));
      const state = new MemoryState();
      const comments = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
      disposeAfter(comments);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const roots = await tree.getChildren();
      for (const [side, root] of [
        ['old', roots[0]!],
        ['new', roots[1]!],
      ] as const) {
        const children = await tree.getChildren(root);
        const node = children.find((child) => child.path === 'stable.ts')!;
        const changed = children.find((child) => child.path === 'changed.ts')!;
        expect(tree.getTreeItem(changed).command?.command).toBe('vsreview.openDiff');
        const changedItem = tree.getTreeItem(changed);
        expect(changedItem.iconPath).toBe(ThemeIcon.File);
        expect(changedItem.label).toBe('changed.ts');
        expect(changedItem.description).toBe(side === 'old' ? '開いているファイル' : '');
        expect(parseStatusUri(changedItem.resourceUri!)).toMatchObject({ side, path: 'changed.ts', status: 'M' });
        expect(provider.provideFileDecoration(changedItem.resourceUri!)).toMatchObject({
          badge: 'M',
        });
        expect(tree.getTreeItem(node).tooltip).toBe('stable.ts');
        expect(tree.getTreeItem(node).accessibilityInformation?.label).toBe('stable.ts');
        expect(tree.getTreeItem(node).label).toBe('stable.ts');
        expect(provider.provideFileDecoration(tree.getTreeItem(node).resourceUri!)).toBeUndefined();
        expect(tree.getTreeItem(node).iconPath).toEqual(ThemeIcon.File);
        expect(tree.getTreeItem(node).description).toBe(side === 'old' ? '' : '開いているファイル');
        expect(tree.getTreeItem(node).command?.command).toBe('vsreview.openRevisionFile');
        await tree.open(node);
        const document = window.activeTextEditor!.document;
        await tree.synchronize();
        expect(tree.getTreeItem(node).description).toContain('開いているファイル');
        expect(
          vi.mocked((tree.view as unknown as ReturnType<typeof window.createTreeView>).reveal),
        ).toHaveBeenLastCalledWith(node, { select: true, focus: false, expand: true });
        expect(document.uri.scheme).toBe('vsreview');
        expect(document.getText()).toBe('const stable = 1;\n');
        const ref = (await documents.resolve(document.uri))!;
        expect(ref.side).toBe(side);
        expect(ref.file).toEqual({ path: 'stable.ts', status: 'M' });
        const thread = controller.createCommentThread(document.uri, new Range(0, 0, 0, 5) as vscode.Range, []);
        await comments.addRangeComment({ thread, text: 'unchanged comment' });
        const saved = comments.all.at(-1)!;
        expect(saved).toMatchObject({
          commit: commit.hash,
          path: 'stable.ts',
          status: 'M',
          side: ref.side,
          code: 'const stable = 1;',
        });
        expect(saved.hunkHeader).toContain('参照コード');
        expect(revisionUri(targetFromComment(saved), ref.side).toString()).toBe(document.uri.toString());
        expect(await workingPosition(document, new Position(0, 5) as vscode.Position, documents, access)).toEqual({
          uri: Uri.file(join(directory, 'stable.ts')),
          position: new Position(0, 5),
        });
      }
      window.showTextDocument.mockClear();
      await tree.open({ kind: 'file', root: {}, path: '../outside' });
      expect(window.showTextDocument).not.toHaveBeenCalled();
    });

    it('フォルダ取得を共有・再利用し、失敗後は履歴更新で再試行し、gitlinkは開けない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${commit.hash},sub`]);
      await gitAsAuthor(directory, ['commit', '-m', 'gitlink']);
      const head = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit: head,
        parent: commit.hash,
        file: { path: 'sub', status: 'A' as const },
      };
      vi.spyOn(git, 'tree').mockRejectedValueOnce(new Error('ls-tree failed'));
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: ls-tree failed');
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      const processes = gitProcesses();
      expect(await tree.getChildren(root)).toEqual([]);
      expect(commandCount(processes, 'ls-tree')).toBe(0);
      await tree.synchronize({ refresh: true });
      const [first, second] = await Promise.all([tree.getChildren(root), tree.getChildren(root)]);
      expect(commandCount(processes, 'ls-tree')).toBe(1);
      await tree.getChildren(root);
      expect(commandCount(processes, 'ls-tree')).toBe(1);
      expect(first.map((node) => tree.getTreeItem(node))).toEqual(second.map((node) => tree.getTreeItem(node)));
      expect(first.map((node) => node.path)).toEqual(['file', 'sub']);
      const sub = first.find((node) => node.path === 'sub')!;
      expect(tree.getTreeItem(sub).description).toContain('サブモジュール（開けません）');
      const provider = new StatusDecorationProvider();
      expect(provider.provideFileDecoration(tree.getTreeItem(sub).resourceUri!)).toMatchObject({
        badge: 'A',
        color: { id: 'gitDecoration.addedResourceForeground' },
      });
      expect(tree.getTreeItem(sub).tooltip).toBe('sub · 追加');
      expect(tree.getTreeItem(sub).accessibilityInformation?.label).toBe('sub · 追加');
      expect(tree.getTreeItem(sub).command).toBeUndefined();
      expect(await tree.getChildren(sub)).toEqual([]);
      await tree.open(sub);
      expect(window.showTextDocument).not.toHaveBeenCalled();
      await tree.synchronize({ refresh: true });
      expect(commandCount(processes, 'log')).toBe(2);
      expect(commandCount(processes, 'ls-tree')).toBe(1);
      expect((await tree.getChildren(root)).map((node) => node.path)).toEqual(['file', 'sub']);
      // 書き換え後の GC 相当: キャッシュがあっても log が失敗したら空にする。
      vi.spyOn(git, 'log').mockRejectedValue(new Error('missing object'));
      vi.spyOn(git, 'isReachable').mockResolvedValue(false);
      window.showErrorMessage.mockClear();
      await tree.synchronize({ refresh: true });
      expect(await tree.getChildren()).toEqual([]);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('ルートコミットの変更前は親なしと表示し、展開しない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'root');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      const access = await accessFor(directory);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const [old, next] = await tree.getChildren();
      expect(tree.getTreeItem(old!).label).toBe('変更前（親なし）');
      expect(tree.getTreeItem(old!).collapsibleState).toBe(TreeItemCollapsibleState.None);
      const processes = gitProcesses();
      expect(await tree.getChildren(old)).toEqual([]);
      expect(processes).not.toHaveBeenCalled();
      expect(tree.getTreeItem(next!).collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
      expect((await tree.getChildren(next)).map((node) => node.path)).toEqual(['file']);
    });

    it('差分を閉じた後に完了した取得で古いルートを復活させない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      let release!: (commits: (typeof commit)[]) => void;
      vi.spyOn(git, 'log').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      const pending = tree.synchronize();
      await waitFor(() => expect(release).toBeTypeOf('function'));
      activateTab(undefined);
      await tree.synchronize();
      release([commit]);
      await pending;
      expect(await tree.getChildren()).toEqual([]);
      expect(tree.view.message).toBe('差分を開くと表示します');
    });

    it('上限未満・上限ちょうどでツリーを再利用し、上限超過で最も長く使われていないツリーを取得し直す', async () => {
      const { directory, git } = await repository();
      const targets: FileTarget[] = [];
      for (let index = 0; index <= SNAPSHOT_CACHE_LIMIT; index++) {
        await writeFile(join(directory, 'file'), String(index));
        await commitAll(directory, `commit ${index}`);
        const commit = (await git.log(0, 1))[0]!;
        targets.push({
          repo: directory,
          commit,
          parent: await git.parent(commit),
          file: { path: 'file', status: index ? 'M' : 'A' },
        });
      }
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      const processes = gitProcesses();
      const first = targets[0]!;
      activateTab(new TabInputTextDiff(revisionUri(first, 'old'), revisionUri(first, 'new')));
      await tree.synchronize();
      expect(commandCount(processes, 'log')).toBe(1);
      for (const [index, target] of targets.entries()) {
        activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
        await tree.synchronize();
        const root = (await tree.getChildren())[1]!;
        expect((await tree.getChildren(root)).map((node) => node.path)).toEqual(['file']);
        if (index === SNAPSHOT_CACHE_LIMIT - 2 || index === SNAPSHOT_CACHE_LIMIT - 1) {
          const loads = commandCount(processes, 'log');
          activateTab(new TabInputTextDiff(revisionUri(first, 'old'), revisionUri(first, 'new')));
          await tree.synchronize();
          const cached = (await tree.getChildren())[1]!;
          expect(commandCount(processes, 'log')).toBe(loads);
          expect(await tree.getChildren(cached)).toHaveLength(1);
        }
      }
      const loads = commandCount(processes, 'log');
      activateTab(new TabInputTextDiff(revisionUri(first, 'old'), revisionUri(first, 'new')));
      await tree.synchronize();
      const reloaded = (await tree.getChildren())[1]!;
      expect(commandCount(processes, 'log')).toBe(loads);
      expect((await tree.getChildren(reloaded)).map((node) => node.path)).toEqual(['file']);
      const evicted = targets[1]!;
      activateTab(new TabInputTextDiff(revisionUri(evicted, 'old'), revisionUri(evicted, 'new')));
      await tree.synchronize();
      expect(commandCount(processes, 'log')).toBe(loads + 1);
      const evictedRoot = (await tree.getChildren())[1]!;
      expect(tree.getTreeItem(evictedRoot).label).toBe(`変更後 ${shortHash(evicted.commit.hash)}`);
      expect((await tree.getChildren(evictedRoot)).map((node) => node.path)).toEqual(['file']);
    });

    it('コピー元自身も変更された場合、変更前の元パスからは元ファイルの差分を開く', async () => {
      const { directory, git } = await repository();
      const sourceLineCount = 20;
      const sourceContent = 'source line\n'.repeat(sourceLineCount);
      await writeFile(join(directory, 'z-source'), sourceContent);
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'a-copy'), sourceContent);
      await writeFile(join(directory, 'z-source'), sourceContent.replace(/source line\n$/, 'changed\n'));
      await commitAll(directory, 'copy and modify');
      const commit = (await git.log(0, 1))[0]!;
      const files = await git.files(commit);
      expect(files.map((file) => file.status)).toEqual(['C', 'M']);
      const target = { repo: directory, commit, parent: await git.parent(commit), file: files[1]! };
      const access = await accessFor(directory);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const old = (await tree.getChildren())[0]!;
      const source = (await tree.getChildren(old))[0]!;
      expect(tree.getTreeItem(source).command?.arguments?.[0]).toMatchObject({
        file: { path: 'z-source', status: 'M' },
      });
    });

    it('未変更のコピー元には変更前でコピー先、変更後でコピー元を表示する', async () => {
      const provider = new StatusDecorationProvider();
      const { directory, git } = await repository();
      await writeFile(join(directory, 'source'), 'source line\n'.repeat(20));
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'copy'), 'source line\n'.repeat(20));
      await commitAll(directory, 'copy');
      const commit = (await git.log(0, 1))[0]!;
      const file = (await git.files(commit))[0]!;
      expect(file.status).toBe('C');
      const target = { repo: directory, commit, parent: await git.parent(commit), file };
      const access = await accessFor(directory);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const roots = await tree.getChildren();
      const source = (await tree.getChildren(roots[0])).find((node) => node.path === 'source')!;
      const copy = (await tree.getChildren(roots[1])).find((node) => node.path === 'copy')!;
      expect(tree.getTreeItem(source).description).toBe('copy · 開いているファイル');
      expect(tree.getTreeItem(copy).description).toBe('source · 開いているファイル');
      for (const node of [source, copy]) {
        expect(provider.provideFileDecoration(tree.getTreeItem(node).resourceUri!)).toMatchObject({
          badge: 'C',
        });
      }
    });

    async function setup() {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'changed'), 'before');
      await writeFile(join(directory, 'stable'), 'stable');
      await commitAll(directory, 'before');
      const before = (await git.log(0, 1))[0]!;
      await writeFile(join(directory, 'changed'), 'after');
      await commitAll(directory, 'after');
      const commit = (await git.log(0, 1))[0]!;
      const target: FileTarget = {
        repo: directory,
        commit,
        parent: before.hash,
        file: { path: 'changed', status: 'M' },
      };
      const access = await accessFor(directory, () => git);
      const documents = reviewDocuments(access);
      const changedFiles = new ChangedFiles(access);
      const tree = filesTree(documents, access, changedFiles);
      disposeAfter(tree);
      disposeAfter(workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)));
      const diff = new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new'));
      activateTab(diff);
      return { git, directory, target, access, documents, tree, diff, changedFiles };
    }

    it.each(['old', 'new'] as const)('履歴更新で空表示のフォルダを再取得し、選択を保つ: %s', async (side) => {
      const { directory, git } = await repository();
      await mkdir(join(directory, 'folder'));
      await writeFile(join(directory, 'folder/stable'), 'stable');
      await writeFile(join(directory, 'changed'), 'before');
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'changed'), 'after');
      await commitAll(directory, 'after');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'changed', status: 'M' as const },
      };
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const root = (await tree.getChildren())[side === 'old' ? 0 : 1]!;
      const folder = (await tree.getChildren(root)).find((node) => node.path === 'folder')!;
      vi.spyOn(git, 'tree').mockRejectedValueOnce(new Error('temporary folder failure'));
      expect(await tree.getChildren(folder)).toEqual([]);
      const displayed = new Map<FileNode, FileNode[]>();
      const updates: Promise<void>[] = [];
      tree.onDidChangeTreeData((node) => {
        if (!node || node === root || node === folder) {
          updates.push(
            tree.getChildren(folder).then((children) => {
              displayed.set(folder, children);
            }),
          );
        }
      });
      const reveal = vi.spyOn(tree.view, 'reveal');
      reveal.mockClear();
      await tree.synchronize({ refresh: true });
      await Promise.all(updates);
      expect(displayed.get(folder)?.map((node) => node.path)).toEqual(['folder/stable']);
      expect(reveal).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it('祖先フォルダの取得失敗後は下位も履歴更新まで再試行せず、更新後に選択する', async () => {
      const { directory, git } = await repository();
      await mkdir(join(directory, 'a/b'), { recursive: true });
      await writeFile(join(directory, 'a/b/file'), 'nested');
      await commitAll(directory, 'nested');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'a/b/file', status: 'A' as const },
      };
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      const original = git.tree.bind(git);
      let fail = true;
      vi.spyOn(git, 'tree').mockImplementation((rev, path) => {
        if (fail && path === 'a') {
          return Promise.reject(new Error('ancestor failure'));
        }
        return original(rev, path);
      });
      const reveal = vi.spyOn(tree.view, 'reveal');
      const processes = gitProcesses();
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await window.showTextDocument(textDocument(revisionUri(target, 'new'), 'nested'));
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      const a = (await tree.getChildren(root))[0]!;
      expect(await tree.getChildren(a)).toEqual([]);
      expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith('VSReview: ancestor failure');
      const loads = commandCount(processes, 'ls-tree');
      await tree.synchronize();
      await tree.synchronize();
      expect(commandCount(processes, 'ls-tree')).toBe(loads);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(reveal).not.toHaveBeenCalled();
      fail = false;
      await tree.synchronize({ refresh: true });
      const b = (await tree.getChildren(a))[0]!;
      const file = (await tree.getChildren(b))[0]!;
      expect(file.path).toBe('a/b/file');
      expect(reveal).toHaveBeenLastCalledWith(file, { select: true, focus: false, expand: true });
    });

    it('途中の選択が追い越されても、最後に描画したファイルの印を消す', async () => {
      const { directory, git } = await repository();
      await mkdir(join(directory, 'b'));
      for (const path of ['a', 'b/nested', 'c']) {
        await writeFile(join(directory, path), path);
      }
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'a', status: 'A' as const },
      };
      const access = await accessFor(directory, () => git);
      const tree = filesTree(reviewDocuments(access), access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      const a = (await tree.getChildren(root)).find((node) => node.path === 'a')!;
      const changed = vi.fn();
      tree.onDidChangeTreeData(changed);
      const original = git.tree.bind(git);
      let release!: () => void;
      vi.spyOn(git, 'tree').mockImplementationOnce(async (rev, path) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(rev, path);
      });
      const b = { ...target, file: { ...target.file, path: 'b/nested' } };
      activateTab(new TabInputTextDiff(revisionUri(b, 'old'), revisionUri(b, 'new')));
      const pending = tree.synchronize();
      await waitFor(() => expect(release).toBeTypeOf('function'));
      expect(tree.getTreeItem(a).description).toContain('開いているファイル');
      const c = { ...target, file: { ...target.file, path: 'c' } };
      activateTab(new TabInputTextDiff(revisionUri(c, 'old'), revisionUri(c, 'new')));
      await tree.synchronize();
      release();
      await pending;
      expect(changed).toHaveBeenCalledWith(a);
      expect(tree.getTreeItem(a).description).not.toContain('開いているファイル');
      const node = (await tree.getChildren(root)).find((node) => node.path === 'c')!;
      expect(tree.getTreeItem(node).description).toContain('開いているファイル');
    });

    it.each(['log', 'tree'] as const)('取得中の破棄後は通知・選択・表示更新をしない: %s', async (method) => {
      const { tree, git } = await setup();
      let release!: () => void;
      const original = git[method].bind(git);
      if (method === 'log') {
        vi.spyOn(git, 'log').mockImplementationOnce(async (...args) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return (original as typeof git.log)(...args);
        });
      } else {
        vi.spyOn(git, 'tree').mockImplementationOnce(async (...args) => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return (original as typeof git.tree)(...args);
        });
      }
      const changed = vi.fn();
      tree.onDidChangeTreeData(changed);
      const pending = tree.synchronize();
      await waitFor(() => expect(release).toBeTypeOf('function'));
      tree.dispose();
      const message = tree.view.message;
      changed.mockClear();
      release();
      await pending;
      const processes = gitProcesses();
      await tree.synchronize({ refresh: true });
      expect(processes).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect((tree.view as unknown as ReturnType<typeof window.createTreeView>).reveal).not.toHaveBeenCalled();
      expect(tree.view.message).toBe(message);
    });

    it('最後のレビュー文書へコミットをまたいで追従し、閉じた未変更文書を保持しない', async () => {
      const { tree, target, diff } = await setup();
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      const stable = (await tree.getChildren(root)).find((node) => node.path === 'stable')!;
      await tree.open(stable);
      const uri = window.activeTextEditor!.document.uri;
      const group = window.tabGroups.activeTabGroup;
      const original = group.activeTab!;
      const virtual = { input: new TabInputText(uri) };
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      const otherTab = { input: new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')) };
      group.tabs = [original, virtual, otherTab];
      group.activeTab = otherTab;
      await window.showTextDocument(textDocument(revisionUri(other, 'new'), 'before'));
      await tree.synchronize();
      group.activeTab = virtual;
      await window.showTextDocument(textDocument(uri, 'stable'));
      await tree.synchronize();
      expect(tree.getTreeItem((await tree.getChildren())[1]!).label).toBe(`変更後 ${shortHash(target.commit.hash)}`);
      expect(tree.getTreeItem(stable).description).toContain('開いているファイル');
      group.tabs = [{ input: diff }, otherTab];
      group.activeTab = undefined;
      await window.showTextDocument(textDocument(Uri.file('/unrelated') as vscode.Uri, ''));
      await tree.synchronize();
      expect(tree.getTreeItem(stable).description).not.toContain('開いているファイル');
    });

    it('仮想文書・通常タブ・別グループでは直前のツリーを保持し、全差分を閉じると空にする', async () => {
      const { tree, diff, target } = await setup();
      await tree.synchronize();
      const labels = (await tree.getChildren()).map((node) => tree.getTreeItem(node).label);
      const root = (await tree.getChildren())[1]!;
      const stable = (await tree.getChildren(root)).find((node) => node.path === 'stable')!;
      await tree.open(stable);
      expect(window.showTextDocument).toHaveBeenLastCalledWith(expect.anything(), { preview: false });
      const group = window.tabGroups.activeTabGroup;
      const normal = { input: new TabInputText(window.activeTextEditor!.document.uri) };
      group.tabs.push(normal);
      group.activeTab = normal;
      await tree.synchronize();
      expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual(labels);
      const unrelated = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
      group.tabs.push(unrelated);
      group.activeTab = unrelated;
      await tree.synchronize();
      expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual(labels);
      window.tabGroups.all.push({ activeTab: unrelated, tabs: [unrelated] });
      await tree.synchronize();
      expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual(labels);
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      activateTab(new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')));
      await tree.synchronize();
      expect(tree.getTreeItem((await tree.getChildren())[1]!).label).toBe(`変更後 ${shortHash(target.parent)}`);
      window.showTextDocument.mockClear();
      await tree.open(stable);
      expect(window.showTextDocument).not.toHaveBeenCalled();
      expect(await tree.getChildren(root)).toEqual([]);
      activateTab(diff);
      await tree.synchronize();
      activateTab(undefined);
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
      expect(tree.view.message).toBe('差分を開くと表示します');
    });

    it('選択していた差分を閉じたら残った差分へ移り、再検証だけでは選択を戻さない', async () => {
      const { tree, target } = await setup();
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      const group = window.tabGroups.activeTabGroup;
      const first = { input: new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')) };
      const second = { input: new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')) };
      const normal = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
      group.tabs = [first, second, normal];
      group.activeTab = first;
      await tree.synchronize();
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      view.reveal.mockClear();
      await tree.synchronize({ refresh: true });
      expect(view.reveal).not.toHaveBeenCalled();
      group.tabs = [second, normal];
      group.activeTab = normal;
      await tree.synchronize();
      expect(tree.getTreeItem((await tree.getChildren())[1]!).label).toBe(`変更後 ${shortHash(target.parent)}`);
    });
    it('同じコミットの別差分が先に並んでいても、通常タブへ移ったら直前のファイルを選ぶ', async () => {
      const { tree, target } = await setup();
      const other = { ...target, file: { path: 'stable', status: 'M' as const } };
      const group = window.tabGroups.activeTabGroup;
      const first = { input: new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')) };
      const selected = { input: new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')) };
      const normal = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
      group.tabs = [first, selected, normal];
      group.activeTab = selected;
      await tree.synchronize();
      await window.showTextDocument(textDocument(revisionUri(target, 'new'), 'after'));
      await tree.synchronize();
      group.activeTab = normal;
      await window.showTextDocument(textDocument(Uri.file('/unrelated') as vscode.Uri, 'normal'));
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      const changed = (await tree.getChildren(root)).find((node) => node.path === 'changed')!;
      const stable = (await tree.getChildren(root)).find((node) => node.path === 'stable')!;
      expect(tree.getTreeItem(changed).description).toContain('開いているファイル');
      expect(tree.getTreeItem(stable).description).not.toContain('開いているファイル');
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      const selectedNode = view.reveal.mock.calls.at(-1)![0] as FileNode;
      expect(selectedNode.kind === 'file' && selectedNode.root.side).toBe('new');
      group.tabs = [first, normal];
      await tree.synchronize();
      expect(tree.getTreeItem(stable).description).toContain('開いているファイル');
      expect(tree.getTreeItem(changed).description).not.toContain('開いているファイル');
    });
    it('フォーカス側の取得失敗は履歴更新まで再試行せず、更新後に選択する', async () => {
      const { tree, git, target } = await setup();
      await window.showTextDocument(textDocument(revisionUri(target, 'new'), 'after'));
      const original = git.tree.bind(git);
      vi.spyOn(git, 'tree').mockImplementationOnce(original).mockRejectedValueOnce(new Error('temporary tree failure'));
      await tree.synchronize();
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      expect(view.reveal.mock.calls.some(([, options]) => options?.select)).toBe(false);
      await tree.synchronize();
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      await tree.synchronize({ refresh: true });
      const selected = view.reveal.mock.calls.at(-1)![0] as FileNode;
      expect(selected.path).toBe('changed');
      expect(selected.kind === 'file' && selected.root.side).toBe('new');
      expect(view.reveal).toHaveBeenLastCalledWith(selected, { select: true, focus: false, expand: true });
    });
    it('両側のツリーが取得できなくても、同じスナップショットでは一度だけ通知する', async () => {
      const { tree, git } = await setup();
      const getTree = vi.spyOn(git, 'tree').mockRejectedValue(new Error('missing tree'));
      await tree.synchronize();
      expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith('VSReview: missing tree');
      const calls = getTree.mock.calls.length;
      await tree.synchronize();
      await tree.synchronize();
      expect(getTree).toHaveBeenCalledTimes(calls);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      await tree.synchronize({ refresh: true });
      expect(getTree).toHaveBeenCalledTimes(calls * 2);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
    });

    it('同じ周期に渡された差分一覧は最後の通知を使う', async () => {
      const { tree, target, documents } = await setup();
      const first = await documents.openDiffs();
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      activateTab(new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')));
      const latest = await documents.openDiffs();
      await Promise.all([tree.synchronize({ diffs: first }), tree.synchronize({ diffs: latest })]);
      expect(tree.getTreeItem((await tree.getChildren())[1]!).label).toBe(`変更後 ${shortHash(other.commit.hash)}`);
    });
    it('再検証の失敗は次の履歴更新まで繰り返さず、履歴更新後に復旧する', async () => {
      const { tree, git } = await setup();
      await tree.synchronize();
      vi.spyOn(git, 'log').mockRejectedValueOnce(new Error('temporary'));
      window.showErrorMessage.mockClear();
      await tree.synchronize({ refresh: true });
      expect(await tree.getChildren()).toEqual([]);
      await tree.synchronize();
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      await tree.synchronize({ refresh: true });
      expect(await tree.getChildren()).toHaveLength(2);
    });
    it('未知のリポジトリと差し替え前の子ノードは取得・openを拒否する', async () => {
      const { tree, target, access } = await setup();
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      const stale = (await tree.getChildren(root)).find((node) => node.path === 'stable')!;
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      activateTab(new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')));
      await tree.synchronize();
      window.showTextDocument.mockClear();
      await tree.open(stale);
      expect(window.showTextDocument).not.toHaveBeenCalled();
      await access.discover([]);
      const processes = gitProcesses();
      expect(await tree.getChildren(root)).toEqual([]);
      expect(processes).not.toHaveBeenCalled();
    });
    it('同じスナップショットの側の切替は該当ノードだけを再描画し、開いている側を表示する', async () => {
      const { tree, target, access, documents } = await setup();
      await tree.synchronize();
      const roots = await tree.getChildren();
      const old = (await tree.getChildren(roots[0])).find((node) => node.path === 'changed')!;
      const next = (await tree.getChildren(roots[1])).find((node) => node.path === 'changed')!;
      const changed = vi.fn();
      tree.onDidChangeTreeData(changed);
      await window.showTextDocument(textDocument(revisionUri(target, 'new'), 'after'));
      await tree.synchronize();
      expect(changed).toHaveBeenCalledWith(old);
      expect(changed).toHaveBeenCalledWith(next);
      expect(changed).not.toHaveBeenCalledWith(undefined);
      expect(tree.getTreeItem(old).description).toContain('開いているファイル');
      expect(tree.getTreeItem(next).description).toContain('開いているファイル');
      const argument: unknown = tree.getTreeItem(next).command!.arguments![0];
      await new ReviewDiff(
        documents,
        access,
        new ChangedFiles(access),
        { gh: unexpectedGh, remote: () => 'origin' },
        { review: () => undefined },
        archiveLease,
      ).openDiff(argument as FileTarget);
      expect(commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        revisionUri(target, 'old'),
        Uri.file(join(target.repo, 'changed')),
        expect.stringContaining('changed'),
        expect.anything(),
      );
    });
    it('非表示中はGitを呼ばず、可視性イベントで最新の差分を表示し、同じ通知では再描画しない', async () => {
      const { tree, target } = await setup();
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      view.setVisible(false);
      const processes = gitProcesses();
      await tree.synchronize({ refresh: true });
      expect(processes).not.toHaveBeenCalled();
      view.setVisible(true);
      await waitFor(async () =>
        expect(tree.getTreeItem((await tree.getChildren())[1]!).label).toBe(`変更後 ${shortHash(target.commit.hash)}`),
      );
      const changed = vi.fn();
      tree.onDidChangeTreeData(changed);
      await Promise.all([tree.synchronize(), tree.synchronize(), tree.synchronize()]);
      expect(changed).not.toHaveBeenCalled();
      expect(commandCount(processes, '--name-status')).toBe(1);
    });

    it('存在しないコミット・到達可能な取得失敗を通知し、未知のリポジトリは通知しない', async () => {
      const { tree, git, access } = await setup();
      const log = vi.spyOn(git, 'log').mockResolvedValueOnce([]);
      vi.spyOn(git, 'isReachable').mockResolvedValue(true);
      await tree.synchronize();
      expect(await tree.getChildren()).toEqual([]);
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: コミットが存在しません');
      log.mockRejectedValueOnce(new Error('log failed'));
      await tree.synchronize({ refresh: true });
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: log failed');
      window.showErrorMessage.mockClear();
      await access.discover([]);
      await tree.synchronize({ refresh: true });
      expect(await tree.getChildren()).toEqual([]);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('revealが失敗してもツリーを保ち、同時取得の失敗は一度だけ通知して再試行する', async () => {
      const { tree, git, target } = await setup();
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      view.reveal.mockRejectedValueOnce(new Error('reveal failed'));
      await tree.synchronize();
      expect(await tree.getChildren()).toHaveLength(2);
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: reveal failed');
      const root = (await tree.getChildren())[1]!;
      vi.spyOn(git, 'tree')
        .mockRejectedValueOnce(new Error('shared failure'))
        .mockResolvedValueOnce([{ kind: 'file', path: 'absent/recovered' }]);
      const folder = {
        kind: 'folder' as const,
        path: 'absent',
        root: root as Extract<typeof root, { kind: 'root' }>,
        parent: root,
      };
      window.showErrorMessage.mockClear();
      await Promise.all([tree.getChildren(folder), tree.getChildren(folder)]);
      expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
      expect(await tree.getChildren(folder)).toEqual([]);
      await tree.synchronize({ refresh: true });
      expect((await tree.getChildren(folder)).map((node) => node.path)).toEqual(['absent/recovered']);

      expect(tree.getTreeItem(root).label).toBe(`変更後 ${shortHash(target.commit.hash)}`);
    });

    it('再検証を途中で通常同期が追い越しても、到達不能なツリーを残さない', async () => {
      const { tree, git } = await setup();
      await tree.synchronize();
      let reject!: (error: Error) => void;
      const log = vi.spyOn(git, 'log').mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      vi.spyOn(git, 'isReachable').mockResolvedValue(false);
      const refresh = tree.synchronize({ refresh: true });
      await waitFor(() => expect(reject).toBeTypeOf('function'));
      log.mockRejectedValue(new Error('gone'));
      await tree.synchronize();
      reject(new Error('gone'));
      await refresh;
      expect(await tree.getChildren()).toEqual([]);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('子取得中の切替と非表示への変更で古い子や選択を反映しない', async () => {
      const { tree, git, target } = await setup();
      await tree.synchronize();
      const roots = await tree.getChildren();
      let release!: (entries: { kind: 'file'; path: string }[]) => void;
      vi.spyOn(git, 'tree').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const folder = {
        kind: 'folder' as const,
        path: 'pending',
        root: roots[1] as Extract<(typeof roots)[number], { kind: 'root' }>,
        parent: roots[1]!,
      };
      const pending = tree.getChildren(folder);
      const other = { ...target, commit: { ...target.commit, hash: target.parent } };
      activateTab(new TabInputTextDiff(revisionUri(other, 'old'), revisionUri(other, 'new')));
      await tree.synchronize();
      release([{ kind: 'file', path: 'pending/stale' }]);
      expect(await pending).toEqual([]);
      expect(await tree.getChildren(roots[1])).toEqual([]);
    });
    it('Commitsで取得した変更ファイルをFilesでも再利用する', async () => {
      const { tree, git, access, changedFiles } = await setup();
      const commits = new CommitsTree(() => [], access, changedFiles);
      disposeAfter(commits);
      await commits.select(git);
      const processes = gitProcesses();
      await commits.getChildren((await commits.getChildren())[0]);
      await tree.synchronize();
      expect(await tree.getChildren()).toHaveLength(2);
      expect(commandCount(processes, '--name-status')).toBe(1);
    });
    it('revealの取得中に非表示になれば選択せず、再表示で再同期する', async () => {
      const { tree, git } = await setup();
      const original = git.tree.bind(git);
      let release!: () => void;
      vi.spyOn(git, 'tree').mockImplementationOnce(async (rev, path) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return original(rev, path);
      });
      const pending = tree.synchronize();
      await waitFor(() => expect(release).toBeTypeOf('function'));
      const view = tree.view as unknown as ReturnType<typeof window.createTreeView>;
      view.setVisible(false);
      release();
      await pending;
      expect(view.reveal).not.toHaveBeenCalled();
      view.setVisible(true);
      await waitFor(() => expect(view.reveal).toHaveBeenCalled());
    });
    it('表示順はフォルダを先にし、同種では大文字を小文字より前にする', async () => {
      const { tree, git } = await setup();
      vi.spyOn(git, 'tree').mockResolvedValue([
        { kind: 'file', path: 'a' },
        { kind: 'folder', path: 'z' },
        { kind: 'file', path: 'B' },
        { kind: 'folder', path: 'A' },
      ]);
      await tree.synchronize();
      const root = (await tree.getChildren())[1]!;
      expect((await tree.getChildren(root)).map((node) => [node.kind, node.path])).toEqual([
        ['folder', 'A'],
        ['folder', 'z'],
        ['file', 'B'],
        ['file', 'a'],
      ]);
    });
  });

  describe('Files の PR 比較', () => {
    it('Files のノード ID は head が同じでも比較の左辺が変われば変わる', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      const access = await accessFor(git.root);
      const documents = reviewDocuments(access);
      const target = { ...(await preparePullRequest(git, pullRequest)), file: { path: 'file', status: 'M' as const } };
      const tree = filesTree(documents, access);
      disposeAfter(tree);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      await tree.synchronize();
      const roots = await tree.getChildren();
      expect(roots).toHaveLength(2);
      const initial = roots.map((node) => tree.getTreeItem(node).id);
      const next = {
        ...target,
        parent: target.commit.hash,
        pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.commit.hash },
      };
      activateTab(new TabInputTextDiff(revisionUri(next, 'old'), revisionUri(next, 'new')));
      await tree.synchronize();
      const nextRoots = await tree.getChildren();
      expect(nextRoots).toHaveLength(2);
      nextRoots.forEach((node, index) => expect(tree.getTreeItem(node).id).not.toBe(initial[index]));
    });
  });

  describe('共有実ファイルの比較選択', () => {
    it('同じ URI の PR とコミットのアクティブ差分に合わせて比較を切り替える', async () => {
      const { pullRequest, source, sourceGit } = await pullRequestRepository();
      await writeFile(join(source, 'file'), 'third');
      await commitAll(source, 'third');
      const commit = (await sourceGit.log(0, 1))[0]!;
      const comparison = await preparePullRequest(sourceGit, { ...pullRequest, headRefOid: commit.hash });
      const target = { ...comparison, file: { path: 'file', status: 'M' as const } };
      const access = await accessFor(source, () => sourceGit);
      const documents = reviewDocuments(access);
      const tree = filesTree(documents, access);
      disposeAfter(tree);
      const right = Uri.file(join(source, 'file')) as vscode.Uri;
      const commitTarget = { repo: source, commit, parent: commit.parents[0]!, file: target.file };
      const commitTab = { input: new TabInputTextDiff(revisionUri(commitTarget, 'old'), right) };
      const prTab = { input: new TabInputTextDiff(revisionUri(target, 'old'), right) };
      const group = window.tabGroups.activeTabGroup;
      group.tabs = [commitTab, prTab];
      window.activeTextEditor = { document: textDocument(right, 'third') } as vscode.TextEditor;
      for (const [tab, expected] of [
        [prTab, target],
        [commitTab, commitTarget],
      ] as const) {
        group.activeTab = tab;
        await tree.synchronize();
        const roots = await tree.getChildren();
        expect(roots[0]?.kind).toBe('root');
        if (roots[0]?.kind !== 'root') {
          throw new Error('root missing');
        }
        expect(roots[0].snapshot.target.parent).toBe(expected.parent);
        expect(roots[0].snapshot.target.pullRequest).toEqual(
          'pullRequest' in expected ? expected.pullRequest : undefined,
        );
      }
    });
  });
});
