import {
  reviewDocuments,
  registerPullRequestsTree,
  reviewsFor,
  gitProcesses,
  waitFor,
  pullRequestRepository,
  repository,
  accessFor,
  disposeAfter,
  reviewComment,
  workspaceFolder,
} from './fixtures';
import { basename, join } from 'node:path';
import { GhClient } from '../src/git/gh';
import { preparePullRequest } from '../src/git/pullRequests';
import { ChangedFiles } from '../src/ui/repositories';
import { window, activateTab, TabInputTextDiff } from './vscodeMock';
import { GitClient, runGit } from '../src/git/client';
import { CommentsTree } from '../src/ui/trees';
import { targetFromComment } from '../src/core/documents';
import { RewrittenComments } from '../src/ui/rewritten';
import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { revisionUri } from '../src/ui/revisions';
import { createUncommittedChanges } from '../src/git/uncommitted';
import type { UncommittedChanges } from '../src/core/uncommitted';

function savedChanges(repoRoot: string, changes: UncommittedChanges) {
  return (['staged', 'unstaged'] as const).map((kind) => ({
    ...reviewComment,
    repoRoot,
    id: kind,
    commit: changes[kind].commit.hash,
    parent: changes[kind].parent,
    uncommitted: { kind, ...(changes.head ? { head: changes.head } : {}), createdAt: changes.createdAt },
  }));
}

describe('rewritten', () => {
  it('未コミットの保存コメントと開いた差分を区分別に判定し、編集と復元に追従する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'base');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'file'), 'staged');
    await runGit(directory, ['add', 'file']);
    await writeFile(join(directory, 'file'), 'working');
    const saved = savedChanges(directory, await createUncommittedChanges(git, '2026-11-14T00:00:00Z'));
    const access = await accessFor(directory);
    const comment = saved[1]!;
    const target = targetFromComment(comment);
    activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
    const documents = reviewDocuments(access);
    const ordinary = { ...reviewComment, repoRoot: directory, commit: 'c'.repeat(40) };
    const rewritten = new RewrittenComments(
      async () => [saved[0]!, ordinary, ...(await documents.openDiffTargets())],
      access,
      { latestHead: () => undefined },
    );
    disposeAfter(rewritten);
    await rewritten.refresh();
    expect(rewritten.has(comment)).toBe(false);
    expect(rewritten.has((await documents.openDiffTargets())[0]!)).toBe(false);
    expect(rewritten.has(ordinary)).toBe(true);
    const tree = new CommentsTree(() => [comment], rewritten);
    disposeAfter(tree);
    expect(tree.getTreeItem(tree.getChildren()[0]!).label).toBe(
      `${basename(directory)} · 未コミットの変更（未ステージ）`,
    );
    expect(tree.getTreeItem(tree.getChildren()[0]!).description).toBe('1 コメント');
    await writeFile(join(directory, 'file'), 'edited');
    await rewritten.refresh();
    expect(rewritten.has(saved[0]!)).toBe(false);
    expect(rewritten.has(comment)).toBe(true);
    expect(tree.getTreeItem(tree.getChildren()[0]!).description).toBe('1 コメント · 内容が変更済み');
    await writeFile(join(directory, 'file'), 'working');
    await rewritten.refresh();
    expect(rewritten.has(comment)).toBe(false);
  });
  it.each(['stage', 'commit', 'head'] as const)('%sによる区分ごとの変化を判定する', async (operation) => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'base');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'file'), 'staged');
    await runGit(directory, ['add', 'file']);
    if (operation === 'head') {
      await commitAll(directory, 'indexed');
    }
    if (operation === 'stage') {
      await writeFile(join(directory, 'file'), 'working');
    }
    const saved = savedChanges(directory, await createUncommittedChanges(git, '2026-11-14T00:00:00Z'));
    const rewritten = new RewrittenComments(() => Promise.resolve(saved), await accessFor(directory), {
      latestHead: () => undefined,
    });
    disposeAfter(rewritten);
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([false, false]);
    if (operation === 'stage') {
      await runGit(directory, ['add', 'file']);
    } else {
      await gitAsAuthor(directory, ['commit', ...(operation === 'head' ? ['--allow-empty'] : []), '-m', 'committed']);
    }
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([true, operation === 'stage']);
  });
  it('リポジトリごとに一度取得し、失敗したリポジトリだけ削除対象から外して復旧する', async () => {
    const first = await repository();
    const second = await repository();
    for (const { directory } of [first, second]) {
      await writeFile(join(directory, 'file'), 'saved');
    }
    const saved = (
      await Promise.all(
        [first, second].map(async ({ directory, git }) =>
          savedChanges(directory, await createUncommittedChanges(git, '2026-11-14T00:00:00Z')),
        ),
      )
    ).flat();
    const access = await accessFor(first.directory);
    await access.discover([workspaceFolder(first.directory), workspaceFolder(second.directory, 1)]);
    const capture = vi.fn((git: GitClient) => createUncommittedChanges(git, '2026-11-15T00:00:00Z'));
    const rewritten = new RewrittenComments(
      () => Promise.resolve(saved),
      access,
      { latestHead: () => undefined },
      capture,
    );
    disposeAfter(rewritten);
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([false, false, false, false]);
    expect(capture).toHaveBeenCalledTimes(2);
    await writeFile(join(first.directory, 'file'), 'edited');
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([false, true, false, false]);
    await writeFile(join(second.directory, 'file'), 'second edited');
    capture.mockRejectedValueOnce(new Error('capture failed'));
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([false, false, false, true]);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: capture failed');
    await writeFile(join(first.directory, 'file'), 'saved');
    await writeFile(join(second.directory, 'file'), 'saved');
    await rewritten.refresh();
    expect(saved.map(rewritten.has)).toEqual([false, false, false, false]);
  });
  it('初回取得失敗は未変更のまま通知し、対象なし・管理外では取得しない', async () => {
    const { directory } = await repository();
    const saved = { ...reviewComment, repoRoot: directory, uncommitted: { kind: 'unstaged' as const, createdAt: '' } };
    let targets = [saved];
    const capture = vi.fn<(git: GitClient) => Promise<UncommittedChanges>>().mockRejectedValue(new Error('failed'));
    const rewritten = new RewrittenComments(
      () => Promise.resolve(targets),
      await accessFor(directory),
      { latestHead: () => undefined },
      capture,
    );
    disposeAfter(rewritten);
    await rewritten.refresh();
    expect(rewritten.has(saved)).toBe(false);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: failed');
    capture.mockClear();
    targets = [];
    await rewritten.refresh();
    targets = [{ ...saved, repoRoot: '/outside' }];
    await rewritten.refresh();
    expect(capture).not.toHaveBeenCalled();
    expect(rewritten.has(targets[0]!)).toBe(false);
  });
  describe('コミットの書き換え判定', () => {
    it('HEAD 到達可能・別ブランチのみ・書き換え・オブジェクト不在を区別する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const first = (await git.log(0, 10))[0]!;
      await runGit(directory, ['checkout', '-b', 'topic']);
      await writeFile(join(directory, 'file'), 'topic');
      await commitAll(directory, 'topic');
      const topic = (await git.log(0, 10))[0]!;
      await runGit(directory, ['checkout', 'main']);
      expect(await git.isReachable(first.hash)).toBe(true);
      expect(await git.isReachable(topic.hash)).toBe(false);
      expect(await git.isReachable('f'.repeat(40))).toBe(false);
      await writeFile(join(directory, 'file'), 'rewritten');
      await commitAll(directory, 'rewritten', { amend: true });
      expect(await git.isReachable(first.hash)).toBe(false);
      const comment = { ...reviewComment, repoRoot: directory, commit: first.hash };
      const rewritten = new RewrittenComments(() => Promise.resolve([comment]), await accessFor(directory), {
        latestHead: () => undefined,
      });
      disposeAfter(rewritten);
      await rewritten.refresh();
      expect(rewritten.has(comment)).toBe(true);
    });

    it('到達可能・管理外・判定失敗と古い非同期応答を区別する', async () => {
      const { directory, git } = await repository();
      expect(await git.isReachable('a'.repeat(40))).toBe(false);
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const comment = { ...reviewComment, repoRoot: directory, commit: (await git.head())! };
      const reachable = new RewrittenComments(
        () => Promise.resolve([comment, { ...comment, repoRoot: '/outside' }]),
        await accessFor(directory),
        { latestHead: () => undefined },
      );
      disposeAfter(reachable);
      await reachable.refresh();
      expect(reachable.has(comment)).toBe(false);
      expect(reachable.has({ ...comment, repoRoot: '/outside' })).toBe(false);
      let call = 0;
      let release: (value: boolean) => void = () => {};
      class DelayedGit extends GitClient {
        override isReachable() {
          if (++call === 1) {
            return new Promise<boolean>((done) => {
              release = done;
            });
          }
          return Promise.resolve(true);
        }
      }
      const access = await accessFor(directory, (repo) => new DelayedGit(repo));
      const rewritten = new RewrittenComments(() => Promise.resolve([comment]), access, {
        latestHead: () => undefined,
      });
      disposeAfter(rewritten);
      const pending = rewritten.refresh();
      await rewritten.refresh();
      release(false);
      await pending;
      expect(rewritten.has(comment)).toBe(false);
      class FailingGit extends GitClient {
        override isReachable(): Promise<boolean> {
          return Promise.reject(new Error('reachability failed'));
        }
      }
      const failed = await accessFor(directory, (repo) => new FailingGit(repo));
      const failing = new RewrittenComments(() => Promise.resolve([comment]), failed, { latestHead: () => undefined });
      disposeAfter(failing);
      await failing.refresh();
      expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: reachability failed');
    });
    it('コメントのない開いた差分も供給集合に含め、最新判定をツリーへ通知する', async () => {
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
      const access = await accessFor(directory);
      const documents = reviewDocuments(access);
      activateTab(new TabInputTextDiff(revisionUri(target, 'old'), revisionUri(target, 'new')));
      const rewritten = new RewrittenComments(() => documents.openDiffTargets(), access, {
        latestHead: () => undefined,
      });
      const comment = { ...reviewComment, repoRoot: directory, commit: commit.hash, parent: await git.parent(commit) };
      const tree = new CommentsTree(() => [comment], rewritten);
      disposeAfter(tree);
      disposeAfter(rewritten);
      const changed = vi.fn();
      tree.onDidChangeTreeData(changed);
      await commitAll(directory, 'amended', { amend: true });
      await Promise.all([rewritten.refresh(), rewritten.refresh()]);
      expect(rewritten.has(comment)).toBe(true);
      expect(changed).toHaveBeenCalled();
      expect(tree.getTreeItem(tree.getChildren()[0]!).description).toContain('書き換え済み');
    });
  });

  describe('PR の書き換え判定', () => {
    async function fixture() {
      const data = await pullRequestRepository();
      const access = await accessFor(data.directory, () => data.git);
      await preparePullRequest(data.git, data.pullRequest);
      let response = JSON.stringify([data.pullRequest]);
      const execute = vi.fn(() => Promise.resolve(response));
      const tree = registerPullRequestsTree({ git: data.git }, new ChangedFiles(access), {
        gh: (root) => new GhClient(root, execute),
        comments: () => [data.saved, { ...data.saved, id: 'duplicate' }],
      });
      disposeAfter(tree);
      const rewritten = new RewrittenComments(() => Promise.resolve([data.saved]), access, reviewsFor(tree));
      disposeAfter(rewritten);
      const headsChanged = vi.fn();
      reviewsFor(tree).onDidChangeHeads(headsChanged);
      async function reload() {
        const before = headsChanged.mock.calls.length;
        await tree.reload();
        await waitFor(() => expect(headsChanged).toHaveBeenCalledTimes(before + 1));
      }
      async function load(json: string) {
        response = json;
        await reload();
        await rewritten.refresh();
      }
      async function advance(divergent: boolean) {
        if (divergent) {
          await runGit(data.source, ['checkout', '--detach', data.base]);
        }
        await writeFile(join(data.source, 'file'), 'latest\n');
        await commitAll(data.source, divergent ? 'force' : 'forward');
        const latest = (await data.sourceGit.head())!;
        await runGit(data.source, ['push', '--force', 'origin', `${latest}:refs/pull/12/head`]);
        return latest;
      }
      return { ...data, access, tree, rewritten, execute, load, advance, reload };
    }
    it.each([false, true])(
      '一覧更新で最新 head がローカルになくても取得し、force push=%s を判定する',
      async (divergent) => {
        const { git, pullRequest, saved, rewritten, load, advance, execute } = await fixture();
        const latest = await advance(divergent);
        expect(await git.hasCommit(latest)).toBe(false);
        await load(JSON.stringify([{ ...pullRequest, headRefOid: latest }]));
        expect(await git.hasCommit(latest)).toBe(true);
        expect(rewritten.has(saved)).toBe(divergent);
        expect(execute).toHaveBeenCalledTimes(1); // 一覧に含まれる PR は view で問い合わせ直さない。
      },
    );
    it('一覧外の同じ PR の保存コメントを重複して問い合わせない', async () => {
      const { tree, execute, saved, reload } = await fixture();
      execute
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce(JSON.stringify({ state: 'OPEN', headRefOid: saved.commit }));
      await reload();
      expect(execute).toHaveBeenCalledTimes(2);
      expect(reviewsFor(tree).latestHead(saved.repoRoot, 12)).toBe(saved.commit);
    });
    it('コメント操作の再判定は gh と fetch を実行しない', async () => {
      const { rewritten, execute, reload } = await fixture();
      await reload();
      execute.mockClear();
      const processes = gitProcesses();
      await rewritten.refresh();
      await rewritten.refresh();
      expect(execute).not.toHaveBeenCalled();
      expect(processes.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('fetch'))).toBe(false);
    });
    it.each([false, true].flatMap((prior) => ['closed', 'gh', 'fetch'].map((failure) => ({ prior, failure }))))(
      '$failure 失敗でも直前の判定 $prior を維持する',
      async ({ prior, failure }) => {
        const { pullRequest, saved, tree, rewritten, execute, advance, load, reload, source, origin } = await fixture();
        const latest = await advance(prior);
        await load(JSON.stringify([{ ...pullRequest, headRefOid: latest }]));
        expect(rewritten.has(saved)).toBe(prior);
        if (failure === 'closed') {
          execute
            .mockResolvedValueOnce('[]')
            .mockResolvedValueOnce(JSON.stringify({ state: 'CLOSED', headRefOid: latest }));
          await reload();
        } else if (failure === 'gh') {
          execute.mockRejectedValueOnce(new Error('offline'));
          await tree.reload();
        } else {
          await writeFile(join(source, 'file'), 'unavailable\n');
          await commitAll(source, 'unavailable');
          await runGit(saved.repoRoot, ['remote', 'set-url', 'origin', join(origin, 'missing')]);
          await load(JSON.stringify([{ ...pullRequest, headRefOid: (await new GitClient(source).head())! }]));
        }
        await rewritten.refresh();
        expect(rewritten.has(saved)).toBe(prior);
        expect(window.showErrorMessage).not.toHaveBeenCalled();
      },
    );
    it('PR のコメントをリポジトリ名付きでまとめ、同じ head のコミットを分離する', async () => {
      const { saved, rewritten } = await fixture();
      const tree = new CommentsTree(
        () => [
          saved,
          { ...saved, id: 'second' },
          { ...reviewComment, repoRoot: saved.repoRoot, commit: saved.commit, id: 'commit' },
        ],
        rewritten,
      );
      disposeAfter(tree);
      const groups = tree.getChildren();
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({
        label: `${basename(saved.repoRoot)} · PR #12 境界値`,
        comments: [saved, { ...saved, id: 'second' }],
      });
    });
    it('最新 head があれば保存 head と base が消えていても書き換え済みにする', async () => {
      const { git, saved, pullRequest, access } = await fixture();
      const missing = {
        ...saved,
        commit: 'f'.repeat(40),
        parent: 'e'.repeat(40),
        pullRequest: {
          ...saved.pullRequest,
          headRefOid: 'f'.repeat(40),
          mergeBase: 'e'.repeat(40),
          baseRefOid: 'e'.repeat(40),
        },
      };
      const rewritten = new RewrittenComments(() => Promise.resolve([missing]), access, {
        latestHead: () => pullRequest.headRefOid,
      });
      disposeAfter(rewritten);
      expect(await git.hasCommit(missing.commit)).toBe(false);
      await rewritten.refresh();
      expect(rewritten.has(missing)).toBe(true);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });
    it.each([false, true].flatMap((prior) => ['missing', 'ancestor'].map((failure) => ({ prior, failure }))))(
      '$failure の検証失敗は直前の判定 $prior を保つ',
      async ({ prior, failure }) => {
        const { git, pullRequest, saved, rewritten, load, advance } = await fixture();
        const latest = await advance(prior);
        await load(JSON.stringify([{ ...pullRequest, headRefOid: latest }]));
        expect(rewritten.has(saved)).toBe(prior);
        if (failure === 'missing') {
          vi.spyOn(git, 'hasCommit').mockResolvedValue(false);
        } else {
          vi.spyOn(git, 'isAncestor').mockRejectedValue(new Error('ancestor failed'));
        }
        await rewritten.refresh();
        expect(rewritten.has(saved)).toBe(prior);
        expect(window.showErrorMessage).not.toHaveBeenCalled();
      },
    );
  });
});
