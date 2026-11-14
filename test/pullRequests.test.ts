import { describe, expect, it } from 'vitest';
import {
  matchingPullRequestRemote,
  pullRequestComparison,
  isPullRequestComparison,
  type PullRequestReview,
  isPullRequestReview,
  parsePullRequests,
  parsePullRequest,
  isPullRequestRewritten,
  parseOpenPullRequestHead,
} from '../src/core/pullRequests';
import { deserialize, serialize } from '../src/core/model';
import { reviewComment, pullRequest, pullRequestReview } from './fixtures';

describe('pullRequests', () => {
  it('比較に外部 PR 判定の真偽と省略を保ち、不正値を拒否する', () => {
    const comparison = { number: 12, headRefOid: 'a'.repeat(40), mergeBase: 'b'.repeat(40) };
    for (const value of [true, false, undefined]) {
      const input = { ...comparison, ...(value === undefined ? {} : { isCrossRepository: value }) };
      expect(pullRequestComparison(input)).toEqual(input);
      expect(isPullRequestComparison(input)).toBe(true);
    }
    for (const value of ['true', 0, null, {}]) {
      expect(isPullRequestComparison({ ...comparison, isCrossRepository: value })).toBe(false);
    }
  });

  describe('PR データ', () => {
    it('空の一覧とフォーク PR を読み取る', () => {
      expect(parsePullRequests('[]')).toEqual([]);
      expect(parsePullRequest(JSON.stringify(pullRequest))).toEqual(pullRequest);
      expect(parsePullRequests(JSON.stringify([pullRequest]))).toEqual([pullRequest]);
    });
    it.each(['', 'null', '{}', '[{}]', '[{"number":0}]'])('不正な一覧 %s を拒否する', (json) => {
      expect(() => parsePullRequests(json)).toThrow();
    });
    it.each([0, -1, 1.5, '12'])('不正な番号 %s を拒否する', (number) => {
      expect(() => parsePullRequest(JSON.stringify({ ...pullRequest, number }))).toThrow();
    });
    it.each([
      { baseRefName: '' },
      { headRefName: '' },
      { baseRefOid: 'bad' },
      { headRefOid: 'bad' },
      { author: {} },
      { author: null },
      { isCrossRepository: 'true' },
      { state: 'UNKNOWN' },
      { state: null },
      { headRepository: {} },
      { headRepositoryOwner: {} },
      { headRepository: 'repo' },
      { headRepositoryOwner: 'owner' },
    ])('不正な PR フィールド %j を拒否する', (invalid) => {
      expect(() => parsePullRequest(JSON.stringify({ ...pullRequest, ...invalid }))).toThrow('形式が不正');
    });
    it('取得時に state と push 先フィールドの欠落を拒否し、削除済み head リポジトリの null は受け付ける', () => {
      for (const field of ['state', 'headRepository', 'headRepositoryOwner'] as const) {
        const value: Partial<typeof pullRequest> = { ...pullRequest };
        delete value[field];
        expect(() => parsePullRequest(JSON.stringify(value))).toThrow('形式が不正');
      }
      const deleted = { ...pullRequest, headRepository: null, headRepositoryOwner: null };
      expect(parsePullRequest(JSON.stringify(deleted))).toEqual(deleted);
    });
    it('追加フィールドのない旧 PR 保存コメントを読み込む', () => {
      const legacy: PullRequestReview = { ...pullRequestReview };
      delete legacy.state;
      delete legacy.headRepository;
      delete legacy.headRepositoryOwner;
      const comment = { ...reviewComment, pullRequest: legacy };
      expect(deserialize(serialize([comment]))).toEqual([comment]);
    });
    it('version 1 の旧データを読み取り、不正な PR 情報を拒否する', () => {
      expect(deserialize(serialize([reviewComment]))).toEqual([reviewComment]);
      const comment = { ...reviewComment, pullRequest: pullRequestReview };
      expect(deserialize(serialize([comment]))).toEqual([comment]);
      expect(() =>
        deserialize(serialize([{ ...comment, pullRequest: { ...pullRequestReview, mergeBase: '-' } }])),
      ).toThrow();
    });
    it('取得済みの開いた head が分岐した場合だけ書き換え済みにする', () => {
      expect(isPullRequestRewritten(pullRequest.headRefOid, pullRequest.headRefOid, false)).toBe(false);
      expect(isPullRequestRewritten(pullRequest.headRefOid, 'c'.repeat(40), true)).toBe(false);
      expect(isPullRequestRewritten(pullRequest.headRefOid, 'c'.repeat(40), false)).toBe(true);
    });
  });

  describe('PR head 応答の検証', () => {
    it.each(['CLOSED', 'MERGED'])('PR が %s のとき最新の未完了 head は返さない', (state) => {
      expect(parseOpenPullRequestHead(JSON.stringify({ state, headRefOid: pullRequest.headRefOid }))).toBeUndefined();
    });
    it.each(['{}', '{', '{"state":"OPEN","headRefOid":"bad"}', '{"state":"UNKNOWN"}'])(
      'head 応答 %s を拒否する',
      (json) => {
        expect(() => parseOpenPullRequestHead(json)).toThrow();
      },
    );
    it('未完了 PR の head を単一のパースで取得する', () => {
      expect(parseOpenPullRequestHead(JSON.stringify({ state: 'OPEN', headRefOid: pullRequest.headRefOid }))).toBe(
        pullRequest.headRefOid,
      );
    });
  });

  it.each(['ssh://git@github.com:2222/example/repo.git', 'https://github.com:8443/example/repo.git'])(
    'ポート付き remote %s を PR URL と照合する',
    (url) => {
      expect(matchingPullRequestRemote([{ name: 'upstream', url }], pullRequest.url)).toBe('upstream');
    },
  );

  it('merge-base のない保存 PR 情報を拒否する', () => {
    expect(isPullRequestReview(pullRequest)).toBe(false);
  });
});
