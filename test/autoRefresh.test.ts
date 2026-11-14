import {
  reviewDocuments,
  pullRequestReview,
  waitFor,
  workspaceFolder,
  accessFor,
  repository,
  reviewComment,
  temporaryDirectory,
  disposeAfter,
} from './fixtures';
import { ChangedFiles } from '../src/ui/repositories';
import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { shortHash } from '../src/core/presentation';
import {
  emitFileEvent,
  documentSaved,
  textDocument,
  activateTab,
  globalConfiguration,
  TabInputTextDiff,
  Uri,
  watchers,
  window,
  workspace,
} from './vscodeMock';
import { AutoRefresh } from '../src/ui/autoRefresh';
import { CommitsTree, CommentsTree } from '../src/ui/trees';
import { RewrittenComments, rewrittenTargets } from '../src/ui/rewritten';
import { revisionUri } from '../src/ui/revisions';
import { commitAll } from './gitFixtures';
import { GitClient, runGit } from '../src/git/client';
import { createUncommittedChanges } from '../src/git/uncommitted';
import type { UncommittedChanges } from '../src/core/uncommitted';

async function fixture() {
  const { directory, git } = await repository();
  await writeFile(join(directory, 'file'), 'one');
  await commitAll(directory, 'initial');
  const commit = (await git.log(0, 10))[0]!;
  const comment = { ...reviewComment, repoRoot: directory, commit: commit.hash, parent: await git.parent(commit) };
  const access = await accessFor(directory);
  const commits = new CommitsTree(() => [comment], access, new ChangedFiles(access));
  await commits.select(git);
  const saved = [comment];
  const documents = reviewDocuments(access);
  const rewritten = new RewrittenComments(() => rewrittenTargets(saved, documents), access, {
    latestHead: () => undefined,
  });
  const comments = new CommentsTree(() => [comment], rewritten);
  const auto = new AutoRefresh(access, commits, rewritten, documents);
  disposeAfter(auto);
  disposeAfter(comments);
  disposeAfter(commits);
  disposeAfter(rewritten);
  return { directory, git, access, commits, rewritten, comments, auto, comment, commit, saved, documents };
}
describe('autoRefresh', () => {
  async function uncommittedFixture() {
    const f = await fixture();
    f.auto.dispose();
    await writeFile(join(f.directory, 'file'), 'saved');
    const initial = await createUncommittedChanges(f.git, '2026-11-14T00:00:00Z');
    const comment = {
      ...f.comment,
      commit: initial.unstaged.commit.hash,
      uncommitted: { kind: 'unstaged' as const, createdAt: initial.createdAt },
    };
    f.saved.splice(0, f.saved.length, comment);
    await f.commits.reload();
    await f.rewritten.refresh();
    const capture = vi.fn((git: GitClient) => createUncommittedChanges(git, new Date().toISOString()));
    const auto = new AutoRefresh(f.access, f.commits, f.rewritten, f.documents, capture);
    disposeAfter(auto);
    await auto.rewatch({ refresh: false });
    const completed = vi.spyOn(f.documents, 'openDiffTargets');
    async function update(path: string, kind: 'changed' | 'created' | 'deleted' = 'changed') {
      completed.mockClear();
      emitFileEvent(path, kind);
      await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    }
    return { ...f, auto, capture, completed, update, comment };
  }
  it.each([false, true])('保存イベントで一覧と変更済み判定を更新する: 監視との重複=%s', async (duplicate) => {
    const { directory, git, commits, rewritten, capture, completed, comment } = await uncommittedFixture();
    await writeFile(join(directory, 'file'), 'edited');
    const doc = textDocument(Uri.file(join(directory, 'file')) as vscode.Uri, 'edited');
    vi.useFakeTimers();
    if (duplicate) {
      emitFileEvent(doc.uri.fsPath);
      await vi.advanceTimersByTimeAsync(100);
    }
    documentSaved.fire(doc);
    await vi.advanceTimersByTimeAsync(299);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledTimes(1);
    const current = await createUncommittedChanges(git, '2026-11-15T00:00:00Z');
    expect((await commits.getChildren())[0]).toMatchObject({
      kind: 'uncommitted',
      changes: { unstaged: { commit: { hash: current.unstaged.commit.hash } } },
    });
    expect(rewritten.has(comment)).toBe(true);
  });
  it('保存でも管理領域・ルート外・無視ファイルを除外する', async () => {
    const { directory, capture, completed } = await uncommittedFixture();
    await writeFile(join(directory, '.gitignore'), 'dist/\n');
    const ignored = vi.spyOn(GitClient.prototype, 'ignoredPaths');
    vi.useFakeTimers();
    for (const path of ['.git', '.git/config', 'nested/.git/config', '../outside/file', 'dist/out.js']) {
      documentSaved.fire(textDocument(Uri.file(join(directory, path)) as vscode.Uri, ''));
    }
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await waitFor(() => expect(ignored).toHaveResolvedWith(new Set(['dist/out.js'])));
    expect(ignored.mock.calls).toEqual([[['dist/out.js']]]);
    expect(capture).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    documentSaved.fire(textDocument(Uri.file(join(directory, 'file')) as vscode.Uri, 'saved'));
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it.each(['rewatch', 'disable', 'dispose'] as const)('保存イベントの登録を解除する: %s', async (action) => {
    const { directory, auto, capture, completed } = await uncommittedFixture();
    const registration = vi.spyOn(workspace, 'onDidSaveTextDocument');
    await auto.rewatch({ refresh: false });
    const subscription = registration.mock.results[0]!.value as vscode.Disposable;
    const disposed = vi.spyOn(subscription, 'dispose');
    const doc = textDocument(Uri.file(join(directory, 'file')) as vscode.Uri, 'saved');
    vi.useFakeTimers();
    documentSaved.fire(doc);
    expect(vi.getTimerCount()).toBe(1);
    if (action === 'dispose') {
      auto.dispose();
    } else {
      if (action === 'disable') {
        globalConfiguration.set('vsreview.autoRefresh', false);
      }
      await auto.rewatch({ refresh: false });
    }
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    documentSaved.fire(doc);
    expect(vi.getTimerCount()).toBe(action === 'rewatch' ? 1 : 0);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    if (action === 'rewatch') {
      await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
      expect(capture).toHaveBeenCalledTimes(1);
    } else {
      expect(capture).not.toHaveBeenCalled();
    }
  });
  it.each(['changed', 'created', 'deleted'] as const)('作業ツリーの%sを共有し履歴を再取得しない', async (kind) => {
    const { directory, git, commits, rewritten, capture, update, comment } = await uncommittedFixture();
    const log = vi.spyOn(GitClient.prototype, 'log');
    const history = vi.fn();
    commits.onDidChangeHistory(history);
    if (kind === 'deleted') {
      await rm(join(directory, 'file'));
    } else {
      await writeFile(join(directory, 'file'), 'edited');
    }
    await update(join(directory, 'file'), kind);
    expect(capture).toHaveBeenCalledTimes(1);
    const node = (await commits.getChildren())[0]!;
    expect(node.kind).toBe('uncommitted');
    if (node.kind !== 'uncommitted') {
      throw new Error('uncommitted expected');
    }
    const current = await createUncommittedChanges(git, '2026-11-15T00:00:00Z');
    expect(node.changes.unstaged.commit.hash).toBe(current.unstaged.commit.hash);
    expect(rewritten.has(comment)).toBe(true);
    expect(log.mock.calls.filter(([, limit]) => limit > 1)).toEqual([]);
    expect(history).not.toHaveBeenCalled();
  });
  it('同じ結果では既存ノードを保ち、復元と最後の変更の消滅に追従する', async () => {
    const { directory, commits, rewritten, update, comment } = await uncommittedFixture();
    const node = (await commits.getChildren())[0]!;
    const changed = vi.fn();
    const judged = vi.fn();
    commits.onDidChangeTreeData(changed);
    rewritten.onDidChange(judged);
    await update(join(directory, 'file'));
    expect(changed).not.toHaveBeenCalled();
    expect(judged).not.toHaveBeenCalled();
    expect((await commits.getChildren(node)).length).toBeGreaterThan(0);
    for (const value of ['edited', 'saved', 'one']) {
      changed.mockClear();
      judged.mockClear();
      await writeFile(join(directory, 'file'), value);
      await update(join(directory, 'file'));
      expect(rewritten.has(comment)).toBe(value !== 'saved');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(judged).toHaveBeenCalledTimes(1);
    }
    expect((await commits.getChildren()).map((n) => n.kind)).toEqual(['commit']);
    await writeFile(join(directory, 'new'), 'new');
    await update(join(directory, 'new'), 'created');
    await rm(join(directory, 'new'));
    await update(join(directory, 'new'), 'deleted');
    expect((await commits.getChildren()).map((n) => n.kind)).toEqual(['commit']);
  });
  it('無視と管理領域・ルート外を除外し、混在と無視判定失敗では更新する', async () => {
    const { directory, access, capture, completed, update } = await uncommittedFixture();
    await writeFile(join(directory, '.gitignore'), 'dist/\n');
    const watcher = watchers.find((w) => !w.disposed && w.pattern.pattern === '**')!;
    expect(watcher).toBeDefined();
    vi.useFakeTimers();
    for (const path of [
      '.git/objects/xx',
      '.git/config',
      '.git/index.lock',
      '.git/FETCH_HEAD',
      '.git',
      '../other/a',
      '../' + directory.split('/').at(-1) + '-other/a',
    ]) {
      watcher.changed.fire(Uri.file(join(directory, path)));
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(capture).not.toHaveBeenCalled();
    const ignored = vi.spyOn(GitClient.prototype, 'ignoredPaths');
    emitFileEvent(join(directory, 'dist/out.js'));
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await waitFor(() => expect(ignored).toHaveResolvedWith(new Set(['dist/out.js'])));
    expect(capture).not.toHaveBeenCalled();
    emitFileEvent(join(directory, 'dist/out.js'));
    watcher.changed.fire(Uri.file(join(directory, '..name')));
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(2));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(ignored.mock.calls.at(-1)?.[0]).toEqual(expect.arrayContaining(['dist/out.js', '..name']));
    capture.mockClear();
    completed.mockClear();
    const client = access.client(directory);
    vi.spyOn(access, 'client').mockReturnValue(client);
    vi.spyOn(client, 'ignoredPaths').mockRejectedValue(new Error('ignore failed'));
    await update(join(directory, 'file'));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });
  it.each(['index', 'path', 'failure'] as const)('各ルートはindex優先で一度だけ判定する: %s', async (kind) => {
    const { directory, access, auto, update } = await uncommittedFixture();
    const second = await repository();
    await access.discover([workspaceFolder(directory), workspaceFolder(second.directory, 1)]);
    await auto.rewatch({ refresh: false });
    const ignored = vi.spyOn(GitClient.prototype, 'ignoredPaths');
    if (kind === 'failure') {
      ignored.mockRejectedValue(new Error('ignore failed'));
    }
    emitFileEvent(join(directory, kind === 'index' ? '.git/index' : 'file'));
    await update(join(second.directory, 'second-file'));
    expect(ignored.mock.calls.map(([paths]) => paths)).toEqual(
      kind === 'index' ? [['second-file']] : [['file'], ['second-file']],
    );
  });
  it.each(['removed', 'rewatch', 'dispose'] as const)('古い監視の無視判定エラーを通知しない: %s', async (kind) => {
    const { directory, access, auto, capture } = await uncommittedFixture();
    let reject!: (error: Error) => void;
    const ignored = vi.spyOn(GitClient.prototype, 'ignoredPaths').mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    vi.useFakeTimers();
    if (kind === 'removed') {
      await access.discover([]);
    }
    emitFileEvent(join(directory, 'file'));
    await vi.advanceTimersByTimeAsync(300);
    if (kind === 'removed') {
      expect(ignored).not.toHaveBeenCalled();
    } else {
      expect(ignored).toHaveBeenCalledTimes(1);
      if (kind === 'rewatch') {
        await auto.rewatch({ refresh: false });
      } else {
        auto.dispose();
      }
      reject(new Error('old ignore failed'));
      await vi.advanceTimersByTimeAsync(0);
    }
    vi.useRealTimers();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
  it('保存の連打を300msでまとめ、取得中の変化は直列に取り直す', async () => {
    const { directory, capture, completed, commits } = await uncommittedFixture();
    let release!: (value: UncommittedChanges) => void;
    const blocked = new Promise<UncommittedChanges>((resolve) => {
      release = resolve;
    });
    const initial = await createUncommittedChanges(new GitClient(directory), '2026-11-14T00:00:00Z');
    capture.mockReturnValueOnce(blocked);
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      emitFileEvent(join(directory, 'file'));
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(199);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await writeFile(join(directory, 'file'), 'latest');
    vi.useFakeTimers();
    emitFileEvent(join(directory, 'file'));
    await vi.advanceTimersByTimeAsync(300);
    expect(capture).toHaveBeenCalledTimes(1);
    release(initial);
    vi.useRealTimers();
    await waitFor(() => expect(completed).toHaveBeenCalledTimes(4));
    expect(capture).toHaveBeenCalledTimes(2);
    const node = (await commits.getChildren())[0]!;
    const current = await createUncommittedChanges(new GitClient(directory), '2026-11-15T00:00:00Z');
    expect(node).toMatchObject({
      changes: { unstaged: { commit: { hash: current.unstaged.commit.hash } } },
    });
  });
  it('失敗も共有し、連続失敗後に復旧する', async () => {
    const { directory, capture, update, commits, rewritten, comment } = await uncommittedFixture();
    await writeFile(join(directory, 'file'), 'edited');
    for (let i = 0; i < 2; i++) {
      capture.mockRejectedValueOnce(new Error('snapshot failed'));
      await update(join(directory, 'file'));
      expect(capture).toHaveBeenCalledTimes(i + 1);
      expect((await commits.getChildren()).map((n) => n.kind)).toEqual(['commit']);
      expect(rewritten.has(comment)).toBe(false);
    }
    await update(join(directory, 'file'));
    expect(capture).toHaveBeenCalledTimes(3);
    expect(rewritten.has(comment)).toBe(true);
    expect((await commits.getChildren())[0]?.kind).toBe('uncommitted');
  });
  it('indexの削除と再作成を監視する', async () => {
    const { directory, update, commits } = await uncommittedFixture();
    await runGit(directory, ['add', 'file']);
    for (const kind of ['deleted', 'created'] as const) {
      await update(join(directory, '.git/index'), kind);
      const node = (await commits.getChildren())[0]!;
      expect(node).toMatchObject({
        changes: { staged: { files: [{ path: 'file', status: 'M' }] }, unstaged: { files: [] } },
      });
    }
  });
  it('複数ルートの失敗を隔離してルートごとに一度取得する', async () => {
    const { directory, access, auto, saved, capture, update, rewritten, comment } = await uncommittedFixture();
    const second = await repository();
    const changes = await createUncommittedChanges(second.git, '2026-11-14T00:00:00Z');
    const other = { ...comment, repoRoot: second.directory, commit: changes.unstaged.commit.hash };
    saved.push(other);
    await access.discover([workspaceFolder(directory), workspaceFolder(second.directory, 1)]);
    await auto.rewatch({ refresh: false });
    await writeFile(join(second.directory, 'new'), 'changed');
    capture.mockImplementation((git) =>
      git.root === directory
        ? Promise.reject(new Error('A failed'))
        : createUncommittedChanges(git, '2026-11-15T00:00:00Z'),
    );
    emitFileEvent(join(second.directory, 'new'));
    await update(join(directory, 'file'));
    expect(capture.mock.calls.map(([git]) => git.root)).toEqual([directory, second.directory]);
    expect([rewritten.has(comment), rewritten.has(other)]).toEqual([false, true]);
  });
  it('Bだけの変更ではAを取り直さず、Aの判定と選択中の一覧を保つ', async () => {
    const { directory, access, auto, saved, capture, update, rewritten, comment, commits } = await uncommittedFixture();
    await writeFile(join(directory, 'file'), 'edited');
    await update(join(directory, 'file'));
    expect(rewritten.has(comment)).toBe(true);
    const second = await repository();
    const changes = await createUncommittedChanges(second.git, '2026-11-14T00:00:00Z');
    const other = { ...comment, repoRoot: second.directory, commit: changes.unstaged.commit.hash };
    saved.push(other);
    await access.discover([workspaceFolder(directory), workspaceFolder(second.directory, 1)]);
    await auto.rewatch({ refresh: false });
    const before = await commits.getChildren();
    const reload = vi.spyOn(commits, 'reload');
    capture.mockClear();
    await writeFile(join(second.directory, 'new'), 'changed');
    await update(join(second.directory, 'new'));
    expect(capture.mock.calls.map(([git]) => git.root)).toEqual([second.directory]);
    expect(reload).not.toHaveBeenCalled();
    expect(await commits.getChildren()).toEqual(before);
    expect([rewritten.has(comment), rewritten.has(other)]).toEqual([true, true]);
  });
  it('無効化・再有効化・選択変更で新しい監視へ移り、タブを変えない', async () => {
    const { directory, auto, capture, commits, access, update } = await uncommittedFixture();
    const node = (await commits.getChildren())[0]!;
    const group = (await commits.getChildren(node))[0]!;
    const file = (await commits.getChildren(group))[0]!;
    if (file.kind !== 'file') {
      throw new Error('file expected');
    }
    const tab = new TabInputTextDiff(revisionUri(file, 'old'), revisionUri(file, 'new'));
    activateTab(tab);
    vi.useFakeTimers();
    emitFileEvent(join(directory, 'file'));
    const old = watchers.filter((w) => !w.disposed);
    globalConfiguration.set('vsreview.autoRefresh', false);
    await auto.rewatch();
    await vi.advanceTimersByTimeAsync(300);
    expect(old.every((w) => w.disposed)).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    vi.useRealTimers();
    globalConfiguration.set('vsreview.autoRefresh', true);
    await auto.rewatch({ refresh: false });
    await update(join(directory, 'file'));
    const second = await repository();
    await access.discover([workspaceFolder(second.directory)]);
    await commits.select(second.git);
    await auto.rewatch({ refresh: false });
    await update(join(second.directory, 'new'), 'created');
    expect(commits.git?.root).toBe(second.directory);
    expect(window.tabGroups.activeTabGroup.activeTab?.input).toBe(tab);
  });
  it('変更済みの未コミット差分をHEADイベント後に一度だけ通知する', async () => {
    const { directory, git, commits, rewritten, documents, auto } = await fixture();
    await writeFile(join(directory, 'file'), 'saved');
    const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const target = {
      repo: directory,
      ...changes.unstaged,
      file: changes.unstaged.files[0]!,
      uncommitted: {
        kind: 'unstaged' as const,
        ...(changes.head ? { head: changes.head } : {}),
        createdAt: changes.createdAt,
      },
    };
    activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
    await auto.rewatch({ refresh: false });
    await writeFile(join(directory, 'file'), 'edited');
    const settled = vi.fn();
    rewritten.onDidChange(settled);
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await waitFor(() =>
      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        'VSReview: 開いている差分の未コミットの変更（未ステージ）は内容が変更済みです',
        5000,
      ),
    );
    settled.mockClear();
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(window.setStatusBarMessage).toHaveBeenCalledTimes(1);
    expect((await documents.openDiffTargets())[0]?.commit).toBe(target.commit.hash);
    expect(commits.git?.root).toBe(directory);
  });
  it('HEADと共通refsを監視し、amend後の一覧・到達判定・開いた差分の通知を更新する', async () => {
    const { directory, commit, commits, rewritten, comment, auto, saved } = await fixture();
    saved.length = 0;
    const oldNode = (await commits.getChildren())[0]!;
    const file = (await commits.getChildren(oldNode))[0]!;
    expect(file.kind).toBe('file');
    if (file.kind !== 'file') {
      throw new Error('fixture file missing');
    }
    activateTab(new TabInputTextDiff(revisionUri(file, 'old'), Uri.file(join(directory, 'file')) as vscode.Uri));
    window.tabGroups.all.push({
      activeTab: undefined,
      tabs: [
        {
          input: new TabInputTextDiff(
            revisionUri({ ...file, file: { ...file.file, path: 'other' } }, 'old'),
            Uri.file(join(directory, 'other')) as vscode.Uri,
          ),
        },
      ],
    });
    const settled = vi.fn();
    rewritten.onDidChange(settled);
    await auto.rewatch();
    await waitFor(() => expect(settled).toHaveBeenCalled());
    await commitAll(directory, 'amended', { amend: true });
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await waitFor(() =>
      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining(shortHash(commit.hash)),
        expect.any(Number),
      ),
    );
    expect(rewritten.has(comment)).toBe(true);
    const latest = (await commits.getChildren())[0]!;
    expect(latest.kind === 'commit' && latest.commit.subject).toBe('amended');
    expect(await commits.getChildren(oldNode)).toEqual([]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(window.tabGroups.activeTabGroup.activeTab?.input).toBeInstanceOf(TabInputTextDiff);
    const rerendered = vi.fn();
    commits.onDidChangeTreeData(rerendered);
    emitFileEvent(join(directory, '.git', 'packed-refs'), 'created');
    await waitFor(() => expect(rerendered).toHaveBeenCalled());
    expect(window.setStatusBarMessage).toHaveBeenCalledTimes(1);
    window.tabGroups.all.splice(1);
    activateTab(
      new TabInputTextDiff(revisionUri({ ...file, repo: '/outside' }, 'old'), Uri.file('/outside/file') as vscode.Uri),
    );
    rerendered.mockClear();
    emitFileEvent(join(directory, '.git', 'refs/heads/topic'), 'deleted');
    await waitFor(() => expect(rerendered).toHaveBeenCalled());
    expect(window.setStatusBarMessage).toHaveBeenCalledTimes(1);
    activateTab(new TabInputTextDiff(revisionUri(file, 'old'), Uri.file(join(directory, 'file')) as vscode.Uri));
    settled.mockClear();
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(window.setStatusBarMessage).toHaveBeenCalledTimes(2);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('設定無効化・再設定・空リポジトリ集合・disposeで監視と予約を解放する', async () => {
    const { auto, commits, access } = await fixture();
    vi.useFakeTimers();
    await auto.rewatch();
    const oldWatchers = [...watchers];
    globalConfiguration.set('vsreview.autoRefresh', false);
    await auto.rewatch();
    expect(oldWatchers.every((w) => w.disposed)).toBe(true);
    globalConfiguration.set('vsreview.autoRefresh', true);
    await auto.rewatch({ refresh: false });
    expect(watchers.some((watcher) => !watcher.disposed)).toBe(true);
    auto.dispose();
    expect(watchers.every((w) => w.disposed)).toBe(true);
    await auto.rewatch();
    expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
    await access.discover([]);
    await commits.select(undefined);
    const emptyRewritten = new RewrittenComments(() => Promise.resolve([]), access, { latestHead: () => undefined });
    const emptyComments = new CommentsTree(() => [], emptyRewritten);
    const empty = new AutoRefresh(access, commits, emptyRewritten, reviewDocuments(access));
    disposeAfter(empty);
    disposeAfter(emptyComments);
    disposeAfter(emptyRewritten);
    await empty.rewatch();
    expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
  });
  it('git-dir取得失敗を通知し、破棄した非同期セットアップから監視を作らない', async () => {
    const { directory, commits, rewritten } = await fixture();
    const invalid = await temporaryDirectory();
    const failed = await accessFor(directory, () => new GitClient(invalid));
    const auto = new AutoRefresh(failed, commits, rewritten, reviewDocuments(failed));
    disposeAfter(auto);
    await auto.rewatch();
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('not a git repository'));
    expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
    const access = await accessFor(directory);
    const late = new AutoRefresh(access, commits, rewritten, reviewDocuments(access));
    disposeAfter(late);
    const pending = late.rewatch();
    late.dispose();
    await pending;
    expect(watchers.every((watcher) => watcher.disposed)).toBe(true);
  });

  it('linked worktreeのHEADと共通refsの変更に追従する', async () => {
    const { directory, git, rewritten, documents } = await fixture();
    const linked = join(await temporaryDirectory(), 'linked');
    await runGit(directory, ['worktree', 'add', '--detach', linked]);
    try {
      const access = await accessFor(linked);
      const commits = new CommitsTree(() => [], access, new ChangedFiles(access));
      const capture = vi.fn((git: GitClient) => createUncommittedChanges(git, '2026-11-15T00:00:00Z'));
      const auto = new AutoRefresh(access, commits, rewritten, documents, capture);
      disposeAfter(auto);
      disposeAfter(commits);
      await commits.select(access.client(linked));
      const settled = vi.fn();
      rewritten.onDidChange(settled);
      await auto.rewatch();
      await waitFor(() => expect(settled).toHaveBeenCalled());
      const dirs = await access.client(linked).directories();
      expect(dirs.gitDir).not.toBe(dirs.commonDir);
      const changed = vi.fn();
      commits.onDidChangeTreeData(changed);
      emitFileEvent(join(dirs.gitDir, 'HEAD'));
      await waitFor(() => expect(changed).toHaveBeenCalled());
      changed.mockClear();
      emitFileEvent(join(dirs.commonDir, 'refs/heads/main'));
      await waitFor(() => expect(changed).toHaveBeenCalled());
      expect(commits.git?.root).toBe(linked);
      expect(await git.head()).toBe(await access.client(linked).head());
      capture.mockClear();
      vi.useFakeTimers();
      emitFileEvent(join(dirs.commonDir, 'index'));
      await vi.advanceTimersByTimeAsync(300);
      expect(capture).not.toHaveBeenCalled();
      vi.useRealTimers();
      await writeFile(join(linked, 'file'), 'indexed');
      await runGit(linked, ['add', 'file']);
      changed.mockClear();
      emitFileEvent(join(dirs.gitDir, 'index'));
      await waitFor(() => expect(changed).toHaveBeenCalled());
      expect(capture).toHaveBeenCalledTimes(1);
      expect((await commits.getChildren())[0]).toMatchObject({ changes: { staged: { files: [{ path: 'file' }] } } });
      auto.dispose();
    } finally {
      await runGit(directory, ['worktree', 'remove', '--force', linked]);
    }
  });
  it('開いていない書き換え済みコメントは判定だけを更新し、通知しない', async () => {
    const { directory, auto, rewritten, comment } = await fixture();
    const changed = vi.fn();
    rewritten.onDidChange(changed);
    await auto.rewatch();
    await waitFor(() => expect(changed).toHaveBeenCalled());
    changed.mockClear();
    await commitAll(directory, 'amended', { amend: true });
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(rewritten.has(comment)).toBe(true);
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
  });
  it('HEADイベントの再読込は進行中の選択を旧リポジトリに戻さない', async () => {
    const { directory, access, commits, rewritten, auto } = await fixture();
    const second = await repository();
    await writeFile(join(second.directory, 'file'), 'two');
    await commitAll(second.directory, 'two');
    const hash = (await second.git.head())!;
    await access.discover([workspaceFolder(directory), workspaceFolder(second.directory, 1)]);
    const settled = vi.fn();
    rewritten.onDidChange(settled);
    await auto.rewatch();
    await waitFor(() => expect(settled).toHaveBeenCalled());
    let release: (hash: string) => void = () => {};
    const head = new Promise<string>((resolve) => {
      release = resolve;
    });
    class DelayedGit extends GitClient {
      override head() {
        return head;
      }
    }
    const selected = commits.select(new DelayedGit(second.directory));
    settled.mockClear();
    let started: () => void = () => {};
    const refreshing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reload = commits.reload.bind(commits);
    vi.spyOn(commits, 'reload').mockImplementation(() => {
      started();
      return reload();
    });
    emitFileEvent(join(directory, '.git', 'HEAD'));
    await refreshing;
    release(hash);
    await selected;
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(commits.git?.root).toBe(second.directory);
    expect((await commits.getChildren())[0]).toMatchObject({ commit: { subject: 'two' } });
  });
  it('旧世代の遅延通知は予約せず、disposeは有効な予約タイマーを除く', async () => {
    const { auto, directory } = await fixture();
    const late: (() => void)[] = [];
    const create = workspace.createFileSystemWatcher;
    vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation((pattern) => {
      const watcher = create(pattern);
      const subscribe = watcher.onDidChange;
      vi.spyOn(watcher, 'onDidChange').mockImplementation((listener) => {
        late.push(() => listener(Uri.file(join(directory, '.git', 'HEAD'))));
        return subscribe(listener);
      });
      return watcher;
    });
    vi.useFakeTimers();
    await auto.rewatch({ refresh: false });
    const stale = [...late];
    await auto.rewatch({ refresh: false });
    for (const request of stale) {
      request();
    }
    expect(vi.getTimerCount()).toBe(0);
    emitFileEvent(join(directory, '.git', 'HEAD'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    auto.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rewatch後に旧世代のdirectoriesが失敗しても通知しない', async () => {
    const { directory, commits, rewritten } = await fixture();
    let reject: (error: Error) => void = () => {};
    const delayed = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    let first = true;
    class DelayedGit extends GitClient {
      override directories() {
        if (first) {
          first = false;
          return delayed;
        }
        return super.directories();
      }
    }
    const access = await accessFor(directory, (root) => new DelayedGit(root));
    const auto = new AutoRefresh(access, commits, rewritten, reviewDocuments(access));
    disposeAfter(auto);
    const pending = auto.rewatch({ refresh: false });
    await auto.rewatch({ refresh: false });
    reject(new Error('stale failure'));
    await pending;
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(watchers.some((watcher) => !watcher.disposed)).toBe(true);
  });
  it('PR の書き換え通知に PR 番号と保存 head を表示する', async () => {
    const { directory, git, access, commits, commit, documents } = await fixture();
    const parent = await git.parent(commit);
    const target = {
      repo: directory,
      commit,
      parent,
      file: { status: 'M' as const, path: 'file' },
      pullRequest: { ...pullRequestReview, headRefOid: commit.hash, mergeBase: parent },
    };
    activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
    await commitAll(directory, 'replacement', { amend: true });
    const latest = (await git.head())!;
    const rewritten = new RewrittenComments(() => documents.openDiffTargets(), access, {
      latestHead: () => latest,
    });
    disposeAfter(rewritten);
    const auto = new AutoRefresh(access, commits, rewritten, documents);
    disposeAfter(auto);
    await auto.rewatch();
    await waitFor(() =>
      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        `VSReview: 開いている差分の PR #12（${shortHash(commit.hash)}）は書き換え済みです`,
        expect.any(Number),
      ),
    );
  });
});
