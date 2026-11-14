import { targetFromComment } from '../src/core/documents';
import {
  unexpectedGh,
  registerPullRequestsTree,
  reviewsFor,
  pullRequestRepository,
  disposeAfter,
  accessFor,
  waitFor,
} from './fixtures';
import { describe, expect, it, vi } from 'vitest';
import { PullRequestReviews } from '../src/ui/pullRequestReviews';
import { GhClient } from '../src/git/gh';
import { preparePullRequest } from '../src/git/pullRequests';
import { ChangedFiles } from '../src/ui/repositories';

describe('pullRequestReviews', () => {
  describe('PR の表示情報と head 収集', () => {
    it('古い reset の完了は新しい reset が保持した比較を消さない', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      const target = await preparePullRequest(git, pullRequest);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const targets = vi
        .fn<() => Promise<readonly (typeof target)[]>>()
        .mockImplementationOnce(async () => {
          await gate;
          return [];
        })
        .mockResolvedValue([target]);
      const reviews = new PullRequestReviews(() => [], targets, { gh: unexpectedGh, remote: () => 'origin' });
      disposeAfter(reviews);
      reviews.rememberReview(target, pullRequest);
      const old = reviews.reset(git.root);
      await reviews.reset(git.root);
      release();
      await old;
      expect(reviews.review(target)).toMatchObject({ number: pullRequest.number, mergeBase: target.parent });
    });
    it('head 取得中も一覧を描画し、同時に取得する保存 PR は4件までにする', async () => {
      const { git, pullRequest, saved } = await pullRequestRepository();
      await preparePullRequest(git, pullRequest);
      const access = await accessFor(git.root, () => git);
      const savedCount = 9; // 同時上限4件を2巡した後、余りの1件も処理する。
      const comments = Array.from({ length: savedCount }, (_, index) => ({
        ...saved,
        id: String(index),
        pullRequest: { ...saved.pullRequest, number: index + 1 },
      }));
      const pending: (() => void)[] = [];
      let active = 0;
      let peak = 0;
      const gh = (repo: string) =>
        new GhClient(repo, (_repo, args) => {
          if (args[1] === 'list') {
            return Promise.resolve(JSON.stringify([pullRequest]));
          }
          active++;
          peak = Math.max(peak, active);
          return new Promise((resolve) =>
            pending.push(() => {
              active--;
              resolve(JSON.stringify({ state: 'OPEN', headRefOid: pullRequest.headRefOid }));
            }),
          );
        });
      const tree = registerPullRequestsTree({ git }, new ChangedFiles(access), { comments: () => comments, gh });
      disposeAfter(tree);
      const updated = vi.fn();
      reviewsFor(tree).onDidChangeHeads(updated);
      await tree.reload();
      expect((await tree.getChildren()).map((node) => tree.getTreeItem(node).label)).toEqual(['#12 境界値']);
      expect(active).toBe(4);
      expect(updated).not.toHaveBeenCalled();
      for (let completed = 0; completed < savedCount; completed++) {
        await waitFor(() => expect(pending.length).toBeGreaterThan(0));
        pending.shift()!();
      }
      await waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
      expect(peak).toBe(4);
      for (const comment of comments) {
        expect(reviewsFor(tree).latestHead(git.root, comment.pullRequest.number)).toBe(pullRequest.headRefOid);
      }
    });
    it.each(['reset', 'dispose'] as const)('%s 後に届く head 応答は状態とイベントへ反映しない', async (operation) => {
      const { git, pullRequest, saved } = await pullRequestRepository();
      await preparePullRequest(git, pullRequest);
      let finish!: (value: string) => void;
      const reviews = new PullRequestReviews(
        () => [saved],
        () => Promise.resolve([]),
        {
          gh: (repo) =>
            new GhClient(
              repo,
              () =>
                new Promise((resolve) => {
                  finish = resolve;
                }),
            ),
          remote: () => 'origin',
        },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      const changed = vi.fn();
      reviews.onDidChangeHeads(changed);
      const pending = reviews.refreshHeads(git, []);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (operation === 'reset') {
        await reviews.reset('/other');
      } else {
        reviews.dispose();
      }
      finish(JSON.stringify({ state: 'OPEN', headRefOid: pullRequest.headRefOid }));
      await pending;
      expect(reviews.latestHead(git.root, 12)).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
    });
    it('base だけが進んでも旧比較には展開時の表示情報を返す', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      const original = await preparePullRequest(git, pullRequest);
      const reviews = new PullRequestReviews(
        () => [],
        () => Promise.resolve([original]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      reviews.rememberReview(original, pullRequest);
      await reviews.reset(git.root);
      const latest = { ...pullRequest, baseRefOid: pullRequest.headRefOid, title: 'base advanced' };
      const next = await preparePullRequest(git, latest);
      reviews.rememberReview(next, latest);
      expect(reviews.review(original)).toEqual({ ...pullRequest, mergeBase: original.parent });
      expect(reviews.review(next)).toEqual({ ...latest, mergeBase: next.parent });
    });
    it('保存 base が取得不能でも最新 head を収集する', async () => {
      const { git, pullRequest, saved } = await pullRequestRepository();
      const missingBase = { ...saved, pullRequest: { ...saved.pullRequest, baseRefOid: 'f'.repeat(40) } };
      const reviews = new PullRequestReviews(
        () => [missingBase],
        () => Promise.resolve([]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      await reviews.refreshHeads(git, [pullRequest]);
      expect(reviews.latestHead(git.root, 12)).toBe(pullRequest.headRefOid);
      expect(await git.hasCommit(pullRequest.headRefOid)).toBe(true);
      expect(await git.hasCommit(missingBase.pullRequest.baseRefOid)).toBe(false);
    });
  });

  describe('保存比較とリポジトリ境界', () => {
    it('記録がなければ同じ保存比較の情報を返し、別 merge-base は返さない', async () => {
      const { git, saved } = await pullRequestRepository();
      const target = targetFromComment(saved);
      const reviews = new PullRequestReviews(
        () => [saved],
        () => Promise.resolve([]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      expect(reviews.review(target)).toEqual(saved.pullRequest);
      expect(
        reviews.review({
          ...target,
          parent: 'f'.repeat(40),
          pullRequest: { ...target.pullRequest!, mergeBase: 'f'.repeat(40) },
        }),
      ).toBeUndefined();
      expect(reviews.latestHead(git.root, 12)).toBeUndefined();
    });
    it('開いていない比較の記録は reset で捨てる', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      const target = await preparePullRequest(git, pullRequest);
      const reviews = new PullRequestReviews(
        () => [],
        () => Promise.resolve([]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      reviews.rememberReview(target, pullRequest);
      expect(reviews.review(target)).toEqual({ ...pullRequest, mergeBase: target.parent });
      await reviews.reset(git.root);
      expect(reviews.review(target)).toBeUndefined();
    });
    it('別リポジトリの保存コメントと開いた比較は head 収集から除外する', async () => {
      const { git, saved, pullRequest } = await pullRequestRepository();
      const foreign = { ...saved, repoRoot: '/other', pullRequest: { ...saved.pullRequest, number: 99 } };
      const execute = vi.fn(() => Promise.reject(new Error('問い合わせ禁止')));
      const reviews = new PullRequestReviews(
        () => [foreign],
        () => Promise.resolve([targetFromComment(foreign)]),
        { gh: (repo) => new GhClient(repo, execute), remote: () => 'origin' },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      await reviews.refreshHeads(git, [pullRequest]);
      expect(execute).not.toHaveBeenCalled();
      expect(reviews.latestHead(git.root, 99)).toBeUndefined();
      expect(reviews.latestHead('/other', 12)).toBeUndefined();
      expect(reviews.latestHead(git.root, 12)).toBe(pullRequest.headRefOid);
    });
    it('別リポジトリの番号指定 head は無視して通知しない', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      const reviews = new PullRequestReviews(
        () => [],
        () => Promise.resolve([]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      reviews.rememberHead(git.root, pullRequest);
      const changed = vi.fn();
      reviews.onDidChangeHeads(changed);
      reviews.rememberHead('/other', { ...pullRequest, headRefOid: 'f'.repeat(40) });
      expect(reviews.latestHead(git.root, 12)).toBe(pullRequest.headRefOid);
      expect(reviews.latestHead('/other', 12)).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
    });
    it.each(['CLOSED', 'MERGED'] as const)('%s PR の head は開いた head を上書きしない', async (state) => {
      const { git, pullRequest } = await pullRequestRepository();
      const reviews = new PullRequestReviews(
        () => [],
        () => Promise.resolve([]),
        { gh: unexpectedGh, remote: () => 'origin' },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      reviews.rememberHead(git.root, pullRequest);
      const changed = vi.fn();
      reviews.onDidChangeHeads(changed);
      reviews.rememberHead(git.root, { ...pullRequest, headRefOid: 'f'.repeat(40), state });
      expect(reviews.latestHead(git.root, 12)).toBe(pullRequest.headRefOid);
      expect(changed).not.toHaveBeenCalled();
    });
    it('番号指定の head 更新を遅い一覧由来の収集で巻き戻さない', async () => {
      const { git, saved, pullRequest } = await pullRequestRepository();
      await preparePullRequest(git, pullRequest);
      let finish!: (value: string) => void;
      const reviews = new PullRequestReviews(
        () => [saved],
        () => Promise.resolve([]),
        {
          gh: (repo) =>
            new GhClient(
              repo,
              () =>
                new Promise((resolve) => {
                  finish = resolve;
                }),
            ),
          remote: () => 'origin',
        },
      );
      disposeAfter(reviews);
      await reviews.reset(git.root);
      const pending = reviews.refreshHeads(git, []);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      reviews.rememberHead(git.root, { ...pullRequest, headRefOid: 'e'.repeat(40) });
      finish(JSON.stringify({ state: 'OPEN', headRefOid: pullRequest.headRefOid }));
      await pending;
      expect(reviews.latestHead(git.root, 12)).toBe('e'.repeat(40));
    });
  });
  it.each(['query', 'fetch'])('head の %s が失敗したら新しい head を公開せず、保存した比較を保つ', async (failure) => {
    const { git, pullRequest, saved } = await pullRequestRepository();
    await preparePullRequest(git, pullRequest);
    const reviews = new PullRequestReviews(
      () => [saved],
      () => Promise.resolve([]),
      {
        gh: (repo) =>
          new GhClient(repo, () => {
            if (failure === 'query') {
              return Promise.reject(new Error('query failed'));
            }
            return Promise.resolve(JSON.stringify({ state: 'OPEN', headRefOid: 'f'.repeat(40) }));
          }),
        remote: () => 'origin',
      },
    );
    disposeAfter(reviews);
    await reviews.reset(git.root);
    await reviews.refreshHeads(git, [pullRequest]);
    expect(reviews.latestHead(git.root, pullRequest.number)).toBe(pullRequest.headRefOid);
    vi.spyOn(git, 'fetch').mockRejectedValue(new Error('fetch failed'));
    await reviews.refreshHeads(git, []);
    expect(reviews.latestHead(git.root, pullRequest.number)).toBeUndefined();
    expect(reviews.review(targetFromComment(saved))).toEqual(saved.pullRequest);
  });
});
