import { describe, expect, it } from 'vitest';
import { isRevision, isRepoPath } from '../src/core/validation';

describe('validation', () => {
  it('フルハッシュとリポジトリ内の相対パスだけを受理する', () => {
    expect(isRevision('a'.repeat(40))).toBe(true);
    expect(isRevision('a'.repeat(64))).toBe(true);
    for (const value of ['', 'a'.repeat(41), '--output=x']) {
      expect(isRevision(value)).toBe(false);
    }
    for (const value of ['../escape', '/absolute', 'a/../../x', 'a/./b', '.', 'a//b', 'a/', '', 'a\0b']) {
      expect(isRepoPath(value)).toBe(false);
    }
    expect(isRepoPath('src/日本 file.ts')).toBe(true);
    for (const path of ['C:\\x', 'a\\b', 'a:b']) {
      expect(isRepoPath(path)).toBe(process.platform !== 'win32');
    }
  });

  describe('追加の境界値テスト', () => {
    it('ハッシュ長の前後と大文字を区別する', () => {
      for (const length of [39, 41, 63, 65]) {
        expect(isRevision('a'.repeat(length))).toBe(false);
      }
      expect(isRevision('A'.repeat(40))).toBe(false);
      expect(isRevision(null)).toBe(false);
    });
  });
});
