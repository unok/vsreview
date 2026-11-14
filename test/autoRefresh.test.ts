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
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shortHash } from '../src/core/presentation';
import {
  emitFileEvent,
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
      const auto = new AutoRefresh(access, commits, rewritten, documents);
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
