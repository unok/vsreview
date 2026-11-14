import { changeMaps } from '../src/core/documents';
import { PromiseCache } from '../src/core/collections';
import { deserialize, serialize } from '../src/core/model';
import { reviewComment as comment } from './fixtures';
import { describe, expect, it } from 'vitest';
import { fileSide, parseLog, parseNameStatus, parseTree } from '../src/core/gitParsing';
import { mapLine, parseHunks, excerpt } from '../src/core/diff';

const patch = '@@ -2,3 +2,4 @@ function x\n context\n-old\n+new\n+extra\n tail\n\\ No newline at end of file\n';

describe('core', () => {
  describe('変更マップ', () => {
    it('各側に存在するパスだけ変更マップへ入れ、コピー元自身の変更を優先する', () => {
      const modified = { status: 'M' as const, path: 'source' };
      const copy = { status: 'C' as const, path: 'copy', oldPath: 'source' };
      const rename = { status: 'R' as const, path: 'renamed', oldPath: 'original' };
      const added = { status: 'A' as const, path: 'added' };
      const deleted = { status: 'D' as const, path: 'deleted' };
      for (const files of [
        [copy, modified, rename, added, deleted],
        [modified, copy, rename, added, deleted],
      ]) {
        const maps = changeMaps(files);
        expect([...maps.old.keys()].sort()).toEqual(['deleted', 'original', 'source']);
        expect([...maps.new.keys()].sort()).toEqual(['added', 'copy', 'renamed', 'source']);
        expect(maps.old.get('source')).toEqual(modified);
        expect(maps.old.get('original')).toEqual(rename);
      }
      expect(changeMaps([])).toEqual({ old: new Map(), new: new Map() });
      expect(fileSide(added, 'old')).toEqual({ path: 'added', empty: true });
      expect(fileSide(deleted, 'new')).toEqual({ path: 'deleted', empty: true });
      expect(fileSide(rename, 'old')).toEqual({ path: 'original', empty: false });
    });
  });
  describe('上限付きキャッシュ', () => {
    it.each([0, -1, 1.5, NaN])('正の整数でない上限を拒否する: %s', (limit) => {
      expect(() => new PromiseCache(limit)).toThrow();
    });
    it('上限省略では保持件数を制限しない', async () => {
      const cache = new PromiseCache<string>();
      const keys = ['first', 'second', 'third'];
      for (const key of keys) {
        await cache.get(key, () => Promise.resolve(key));
      }
      for (const key of keys) {
        expect(await cache.get(key, () => Promise.resolve('reloaded'))).toBe(key);
      }
    });
    it('ヒットで使用順を更新し、上限超過では最も長く使われていない値を再取得する', async () => {
      const cache = new PromiseCache<string>(2);
      let version = 0;
      const load = () => Promise.resolve(String(++version));
      expect(await cache.get('a', load)).toBe('1');
      expect(await cache.get('b', load)).toBe('2');
      expect(await cache.get('a', load)).toBe('1');
      expect(await cache.get('c', load)).toBe('3');
      expect(await cache.get('a', load)).toBe('1');
      expect(await cache.get('b', load)).toBe('4');
    });
    it('削除した古い取得の失敗で新しい取得を消さず、失敗後は再試行できる', async () => {
      const cache = new PromiseCache<string>(1);
      let reject!: (error: Error) => void;
      const old = cache.get(
        'a',
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      cache.delete('a');
      expect(await cache.get('a', () => Promise.resolve('new'))).toBe('new');
      reject(new Error('old failure'));
      await expect(old).rejects.toThrow('old failure');
      expect(await cache.get('a', () => Promise.resolve('wrong'))).toBe('new');
      await expect(cache.get('b', () => Promise.reject(new Error('retry')))).rejects.toThrow('retry');
      expect(await cache.get('b', () => Promise.resolve('retried'))).toBe('retried');
    });
  });
  it('hunk の行数とファイル境界を超えてヘッダをコードに混ぜない', () => {
    const patch =
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-before\n+after\n';
    expect(parseHunks(patch)[0]?.lines.map((row) => row.text)).toEqual(['old', 'new']);
  });

  describe('Git の機械可読出力', () => {
    const hash = 'a'.repeat(40);
    it('NUL区切りでタブや改行を含むパスとGitの出力順を保つ', () => {
      expect(
        parseTree(
          `100644 blob ${hash}\tz\0` +
            `160000 commit ${hash}\tsub\0` +
            `040000 tree ${hash}\t日本 語\0` +
            `100755 blob ${hash}\ta\t\n\0`,
        ),
      ).toEqual([
        { kind: 'file', path: 'z' },
        { kind: 'gitlink', path: 'sub' },
        { kind: 'folder', path: '日本 語' },
        { kind: 'file', path: 'a\t\n' },
      ]);
      expect(parseTree('')).toEqual([]);
      expect(parseTree(`120000 blob ${hash}\tlink\0`)).toEqual([{ kind: 'file', path: 'link' }]);
    });
    it.each([
      `100644 blob ${hash} x\0`,
      `100644 blob ${hash}x\0`,
      `100644 blob ${hash}\tx`,
      `100644 blob nope\tx\0`,
      `100644 blob ${hash}\t../x\0`,
      `040000 blob ${hash}\tx\0`,
      `160000 blob ${hash}\tx\0`,
      `100644 commit ${hash}\tx\0`,
      `100644 blob ${hash} extra\tx\0`,
      `100664 blob ${hash}\tx\0`,
      '\0',
    ])('壊れた出力を拒否する: %s', (output) => {
      expect(() => parseTree(output)).toThrow();
    });

    it('空出力と複数行の本文を読む', () => {
      expect(parseLog('')).toEqual([]);
      expect(parseLog('abc\0def ghi\0subject\0作者\0' + '2026-01-01\0subject\n\nbody\n\0')[0]).toMatchObject({
        hash: 'abc',
        parents: ['def', 'ghi'],
        message: 'subject\n\nbody\n',
      });
    });
    it('空白・日本語・タブを含むリネームを保持する', () => {
      expect(parseNameStatus('R100\0old name\0新\tname\0A\0a\0')).toEqual([
        { status: 'R', path: '新\tname', oldPath: 'old name' },
        { status: 'A', path: 'a' },
      ]);
      expect(() => parseNameStatus('R100\0old\0')).toThrow('リネーム先がありません');
    });
  });
  describe('hunk と行対応（1 始まり）', () => {
    it('変更前・変更箇所・変更後の行を対応づける', () => {
      expect(parseHunks(patch)).toHaveLength(1);
      expect(mapLine(patch, 1)).toEqual({ line: 1 });
      expect(mapLine(patch, 2)).toEqual({ line: 2 });
      expect(mapLine(patch, 3)).toEqual({ reason: '作業ツリーで変更または削除された行です' });
      expect(mapLine(patch, 4)).toEqual({ line: 5 });
      expect(mapLine(patch, 10)).toEqual({ line: 11 });
    });
    it('挿入・削除・ファイル削除・リネームを処理する', () => {
      expect(mapLine('@@ -0,0 +1,2 @@\n+a\n+b\n', 1)).toEqual({ line: 3 });
      expect(mapLine('@@ -2,2 +1,0 @@\n-a\n-b\n', 4)).toEqual({ line: 2 });
      expect(mapLine('', 1, { deleted: true })).toEqual({ reason: '作業ツリーからファイルが削除されています' });
      expect(mapLine('', 5, { renamedTo: 'new.ts' })).toEqual({ line: 5, path: 'new.ts' });
      expect(mapLine('', 0)).toEqual({ reason: '行番号が範囲外です' });
    });
    it('対象行マーカーと前後のコンテキストを出す', () => {
      expect(excerpt(patch, 'new', 3, 4)).toContain('> +new\n> +extra');
      expect(excerpt(patch, 'old', 3, 3)).toContain('> -old');
      expect(excerpt('', 'file', 0, 0)).toBe('');
    });
  });
  describe('保存', () => {
    it('JSON を往復し、壊れた保存データを拒否する', () => {
      expect(deserialize(serialize([comment]))).toEqual([comment]);
      expect(() => deserialize({ version: 1, comments: [{}] })).toThrow('保存されたレビューコメントの形式が不正です');
      expect(() => deserialize({ version: 2, comments: [] })).toThrow('保存されたレビューコメントの形式が不正です');
    });
  });

  describe('行対応の境界', () => {
    it('hunk の省略 count・複数 hunk・挿入位置の直前と直後', () => {
      expect(mapLine('@@ -3,0 +4,2 @@\n+x\n+y\n', 3)).toEqual({ line: 3 });
      expect(mapLine('@@ -3,0 +4,2 @@\n+x\n+y\n', 4)).toEqual({ line: 6 });
      const multiple = '@@ -2 +2,2 @@\n-b\n+B\n+X\n@@ -8,2 +9 @@\n-h\n-i\n+H\n';
      expect(mapLine(multiple, 7)).toEqual({ line: 8 });
      expect(mapLine(multiple, 8)).toEqual({ reason: '作業ツリーで変更または削除された行です' });
      expect(mapLine(multiple, 10)).toEqual({ line: 10 });
    });
    it('コンテキスト内の未変更行と空ファイルへの挿入', () => {
      expect(mapLine('@@ -1,3 +1,2 @@\n a\n-b\n c\n', 3)).toEqual({ line: 2 });
      expect(parseHunks('@@ -0,0 +1 @@\n+x\n')[0]).toMatchObject({ oldCount: 0, newCount: 1 });
      expect(parseHunks('Binary files a and b differ')).toEqual([]);
    });
  });

  it('保存アンカーのハッシュ・パス・行番号・ファイル範囲を検証する', () => {
    for (const fields of [
      { commit: '--output=x' },
      { parent: 'no' },
      { path: '../outside' },
      { oldPath: '/bad' },
      { side: 'old', startLine: 0 },
      { endLine: 2 },
      { startLine: 1.5 },
      { side: 'file', startLine: 1, endLine: 1 },
    ]) {
      expect(() => deserialize({ version: 1, comments: [{ ...comment, ...fields }] })).toThrow(
        '保存されたレビューコメントの形式が不正です',
      );
    }
    expect(() => parseLog('broken\0')).toThrow('git log の出力が不完全です');
    for (const text of ['X\0file\0', 'A\0\0', 'R\0old\0', 'A\0file']) {
      expect(() => parseNameStatus(text)).toThrow(
        /変更ファイルの形式が不正|リネーム先がありません|git diff の出力が不完全/,
      );
    }
  });

  describe('パーサと出力の完全な結果', () => {
    it('複数レコードと親のないコミットを順序通り読む', () => {
      const child = ['child', 'root', 'child subject', 'author', 'date', 'child body\n'].join('\0') + '\0';
      const root = ['root', '', 'root subject', 'author', 'date', 'root body\n'].join('\0') + '\0';
      expect(parseLog(child + root)).toEqual([
        {
          hash: 'child',
          parents: ['root'],
          subject: 'child subject',
          author: 'author',
          date: 'date',
          message: 'child body\n',
        },
        { hash: 'root', parents: [], subject: 'root subject', author: 'author', date: 'date', message: 'root body\n' },
      ]);
    });
    it('終端改行マーカーをコード行にせず、非整数行を拒否する', () => {
      expect(parseHunks(patch)[0]?.lines.map((row) => row.text)).toEqual(['context', 'old', 'new', 'extra', 'tail']);
      expect(mapLine(patch, 1.5)).toEqual({ reason: '行番号が範囲外です' });
    });
    it('hunk抜粋は前後3行に限定し、対象外なら空、複数hunkなら順序を保つ', () => {
      const hunk = '@@ -1,9 +1,9 @@\n' + Array.from({ length: 9 }, (_, i) => ' ' + String(i + 1)).join('\n') + '\n';
      expect(excerpt(hunk, 'new', 5, 5)).toBe('@@ -1,9 +1,9 @@\n   2\n   3\n   4\n>  5\n   6\n   7\n   8');
      expect(excerpt(hunk, 'new', 20, 20)).toBe('');
      expect(excerpt('@@ -1 +1 @@\n-a\n+A\n@@ -4 +4 @@\n-d\n+D\n', 'new', 1, 4)).toBe(
        '@@ -1 +1 @@\n  -a\n> +A\n@@ -4 +4 @@\n  -d\n> +D',
      );
    });

    it('ファイルの0行と不正な配列・oldPathを検証する', () => {
      expect(
        deserialize({ version: 1, comments: [{ ...comment, side: 'file', startLine: 0, endLine: 0 }] }),
      ).toHaveLength(1);
      for (const input of [
        { version: 1, comments: {} },
        { version: 1, comments: [{ ...comment, oldPath: 1 }] },
      ]) {
        expect(() => deserialize(input)).toThrow('保存されたレビューコメントの形式が不正です');
      }
    });
  });
});
