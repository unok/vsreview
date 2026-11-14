import { describe, expect, it } from 'vitest';
import { anchorContext } from '../src/core/anchor';

describe('anchor', () => {
  it('リネームだけのファイルも対象コードと前後3行を保存する', () => {
    const result = anchorContext('1\n2\n3\n4\n5\n6\n7\n8\n9', '', 'old', 5, 5);
    expect(result.code).toBe('5');
    expect(result.excerpt.split('\n')).toHaveLength(8);
    expect(result.excerpt).toContain('>  5');
    expect(result.excerpt).toBe('@@ -2,7 +2,7 @@ (参照コード)\n   2\n   3\n   4\n>  5\n   6\n   7\n   8');
    expect(result.hunkHeader).toContain('参照コード');
  });
  it('CRLF、改行なし末尾、範囲外を扱う', () => {
    expect(() => anchorContext('a\nb', '', 'old', 2, 1)).toThrow('コメントの範囲がファイルの外です');

    expect(anchorContext('a\r\nb', '', 'new', 2, 2).code).toBe('b');
    expect(() => anchorContext('a', '', 'new', 0, 1)).toThrow('コメントの範囲がファイルの外です');
    expect(() => anchorContext('a', '', 'new', 1, 2)).toThrow('コメントの範囲がファイルの外です');
  });
  it('先頭・末尾の抜粋はファイル範囲に収める', () => {
    const text = '1\n2\n3\n4\n5\n6\n7\n8\n9';
    const head = anchorContext(text, '', 'new', 1, 1);
    expect(head.code).toBe('1');
    expect(head.excerpt).toBe('@@ -1,4 +1,4 @@ (参照コード)\n>  1\n   2\n   3\n   4');
    const tail = anchorContext(text, '', 'old', 9, 9);
    expect(tail.code).toBe('9');
    expect(tail.excerpt).toBe('@@ -6,4 +6,4 @@ (参照コード)\n   6\n   7\n   8\n>  9');
  });
  it('対象を含むhunkの見出しを保存する', () => {
    const header = '@@ -1,2 +1,2 @@ function example';
    expect(anchorContext('a\nB', `${header}\n a\n-b\n+B\n`, 'new', 2, 2).hunkHeader).toBe(header);
  });
  it('空の文書も VS Code の1行の空行として保存する', () => {
    expect(anchorContext('', '', 'new', 1, 1)).toEqual({
      code: '',
      hunkHeader: '@@ -1,1 +1,1 @@ (参照コード)',
      excerpt: '@@ -1,1 +1,1 @@ (参照コード)\n>  ',
    });
  });

  describe('範囲選択', () => {
    it('hunk外の複数行には参照コードを保存する', () => {
      const result = anchorContext('1\n2\n3\n4\n5\n6\n7\n8\n9', '@@ -8 +8 @@\n-old\n+8\n', 'new', 1, 2);
      expect(result).toEqual({
        code: '1\n2',
        hunkHeader: '@@ -1,5 +1,5 @@ (参照コード)',
        excerpt: '@@ -1,5 +1,5 @@ (参照コード)\n>  1\n>  2\n   3\n   4\n   5',
      });
    });
  });
});
