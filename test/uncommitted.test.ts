import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../src/core/model';
import { pullRequestReview, reviewComment } from './fixtures';

describe('未コミットのコメントの保存', () => {
  it('新フィールドのない version 1 のコミット・PR コメントに種別を補完する', () => {
    const legacy = {
      id: 'old',
      repoRoot: '/repo',
      commit: 'b'.repeat(40),
      parent: 'a'.repeat(40),
      path: 'file.ts',
      status: 'M',
      side: 'new',
      startLine: 1,
      endLine: 1,
      code: 'before',
      hunkHeader: '@@ -1 +1 @@',
      excerpt: '+before',
      body: 'review',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      resolved: false,
      subject: 'subject',
      author: 'author',
      date: '2026-01-01T00:00:00Z',
    };
    for (const comment of [legacy, { ...legacy, pullRequest: pullRequestReview }]) {
      const saved = { version: 1, comments: [comment] };
      const restored = deserialize(saved);
      expect(restored).toEqual([{ ...comment, purpose: 'fix' }]);
      expect(serialize(restored)).toEqual({ version: 1, comments: [{ ...comment, purpose: 'fix' }] });
      expect(comment).not.toHaveProperty('purpose');
    }
  });

  for (const kind of ['staged', 'unstaged'] as const) {
    for (const head of [undefined, 'a'.repeat(40), 'a'.repeat(64)]) {
      it(`${kind} / head=${head} のメタデータと本文・抜粋を保持する`, () => {
        const uncommitted = { kind, createdAt: '2026-11-14T00:00:00Z', ...(head ? { head } : {}) };
        const comment = { ...reviewComment, uncommitted };
        const json: unknown = JSON.parse(JSON.stringify(serialize([comment])));
        expect(deserialize(json)).toEqual([comment]);
      });
    }
  }

  for (const uncommitted of [
    null,
    {},
    [],
    { kind: 'other', createdAt: 'now' },
    { kind: 'staged', head: 'bad', createdAt: 'now' },
    { kind: 'unstaged', createdAt: 1 },
    { kind: 'staged' },
  ]) {
    it(`不正なメタデータ ${JSON.stringify(uncommitted)} を拒否する`, () => {
      expect(() => deserialize({ version: 1, comments: [{ ...reviewComment, uncommitted }] })).toThrow(
        '保存されたレビューコメントの形式が不正です',
      );
    });
  }

  it('PR と未コミットのメタデータの併用を拒否する', () => {
    const comment = {
      ...reviewComment,
      pullRequest: pullRequestReview,
      uncommitted: { kind: 'staged', createdAt: 'now' },
    };
    expect(() => deserialize({ version: 1, comments: [comment] })).toThrow(
      '保存されたレビューコメントの形式が不正です',
    );
  });
});
