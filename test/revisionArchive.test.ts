import { describe, expect, it } from 'vitest';
import {
  archiveBareRoots,
  archivePathCollisions,
  ArchiveBudget,
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_PATH_BYTES,
  ARCHIVE_MAX_FILES,
  archivePath,
  archiveExcludedPath,
  archiveEvictions,
  archiveLinkPaths,
  archiveLinkPatternName,
  archiveDirectories,
} from '../src/core/revisionArchive';

describe('revisionArchive', () => {
  it('リンクパターンの名前と履歴の親を境界で区別する', () => {
    expect(archiveLinkPatternName('**/node_modules')).toBe('node_modules');
    for (const path of ['', '**/', '**', '**/node_modules/', 'node_modules', 'a/**/deps']) {
      expect(archiveLinkPatternName(path)).toBeUndefined();
    }
    expect(() => archiveLinkPaths(['**/'], 'linux')).toThrow();
    expect(() => archiveLinkPaths(['**/node_modules/'], 'linux')).toThrow();
    expect(archiveDirectories([])).toEqual(new Set(['']));
    expect(archiveDirectories(['file'])).toEqual(new Set(['']));
    expect(archiveDirectories(['a/b/c/file', 'a/b/other'])).toEqual(new Set(['', 'a', 'a/b', 'a/b/c']));
  });
  it.each([
    '',
    '/a',
    '../a',
    'a/../b',
    'a//b',
    'a/',
    '.git/config',
    '.GIT/config',
    '.git./config',
    '.git /config',
    'GIT~1/config',
    'GIT~10/x',
    '．ｇｉｔ/config',
    '.g\u200bit/config',
    '.g\u2060it/config',
    'a\0b',
  ])('危険なパス %j を拒否する', (path) => {
    expect(() => archivePath(path)).toThrow();
  });
  it.each([
    'a\\b',
    'C:drive',
    'a<',
    'a>',
    'a"',
    'a|',
    'a?',
    'a*',
    'a\u0001',
    'a.',
    'a ',
    'CON',
    'LONGNA~1.txt',
    'HEAD~2',
  ])('Windows で書けない別名 %s を拒否する', (path) => {
    expect(() => archivePath(path, 'win32')).toThrow('展開先のパスが不正');
  });
  it('大小文字と正規化の同一視を別々に扱う', () => {
    expect(archivePathCollisions(['é.ts', 'e\u0301.ts'], true, false)).toEqual([]);
    expect(archivePathCollisions(['A', 'a'], true, false)).toEqual(['A', 'a']);
    expect(archivePathCollisions(['é.ts', 'e\u0301.ts'], false, true)).toEqual(['é.ts', 'e\u0301.ts']);
    expect(archiveBareRoots(['bare/HEAD', 'bare/objects', 'bare/refs'])).toEqual(['bare']);
  });
  it.each([
    [[], 'a', false],
    [[''], 'a/b', true],
    [['a'], 'a', true],
    [['a'], 'a/b', true],
    [['a'], 'ab', false],
  ] as const)('除外ルート %j とパス %s の境界', (roots, path, expected) => {
    expect(archiveExcludedPath(roots)(path)).toBe(expected);
  });
  it('POSIX のコロンとバックスラッシュを保ち Windows では予約名も拒否する', () => {
    for (const path of ['a:b', 'a\\b', 'CON', 'nul.txt', 'dir/LPT9.log', 'aux ', 'com¹']) {
      expect(archivePath(path, 'linux')).toBe(path);
      expect(() => archivePath(path, 'win32')).toThrow();
    }
    expect(archivePath('日本 語/source.ts')).toBe('日本 語/source.ts');
    expect(archivePath('console.ts', 'win32')).toBe('console.ts');
    expect(archivePath('git~0/x')).toBe('git~0/x');
    for (const name of ['CONIN$', 'conout$.txt']) {
      expect(() => archivePath(name, 'win32')).toThrow();
    }
  });
  it('リンク設定の空配列を受け入れ、不正値と双方向の重複を拒否する', () => {
    expect(archiveLinkPaths([])).toEqual([]);
    expect(archiveLinkPaths(['a', 'ab'])).toEqual(['a', 'ab']);
    expect(archiveLinkPaths(['node_modules', 'vendor/lib'])).toEqual(['node_modules', 'vendor/lib']);
    for (const value of [
      null,
      'node_modules',
      ['../x'],
      ['.git'],
      ['/x'],
      ['a', 'a/b'],
      ['a/b', 'a'],
      ['a', 'a'],
      [1],
    ]) {
      expect(() => archiveLinkPaths(value)).toThrow();
    }
  });
  it('直下を含む同名ディレクトリのパターンと固定パスを併用する', () => {
    const paths = ['**/node_modules', 'node_modules', '**/node_modules', 'vendor/lib'];
    expect(archiveLinkPaths(paths)).toEqual(paths);
    for (const path of ['**/.git', '**/..', '**/.', '**/GIT~1']) {
      expect(() => archiveLinkPaths([path])).toThrow();
    }
    for (const path of ['a*/b', 'a/**/b', '**/a/b', '**/a*', '***']) {
      expect(archiveLinkPaths([path], 'linux')).toEqual([path]);
      expect(() => archiveLinkPaths([path], 'win32')).toThrow();
    }
  });
  it('HEAD と objects・refs または commondir からベア構成を判定する', () => {
    expect(archiveBareRoots(['repo/HEAD', 'repo/objects/x', 'repo/refs/x'])).toEqual(['repo']);
    expect(archiveBareRoots(['HEAD', 'commondir'])).toEqual(['']);
    expect(archiveBareRoots(['Repo/HEAD', 'repo/objects/x', 'REPO/refs/x'])).toEqual(['Repo', 'repo', 'REPO']);
    expect(archiveBareRoots(['repo/ＨＥＡＤ.', 'repo/ob\u200bjects/x', 'repo/Refs /x'])).toEqual(['repo']);
    for (const paths of [
      ['HEAD', 'objects/x'],
      ['HEAD', 'refs/x'],
      ['objects/x', 'refs/x'],
      ['head/x', 'commondir/x'],
    ]) {
      expect(archiveBareRoots(paths)).toEqual([]);
    }
  });
  it('大小文字が衝突するファイルとディレクトリを双方除外する', () => {
    expect(archivePathCollisions(['e\u0301.ts', 'é.ts', 'safe'], false, true)).toEqual(['e\u0301.ts', 'é.ts']);
    expect(archivePathCollisions(['A.ts', 'a.ts', 'safe'], false)).toEqual([]);
    expect(archivePathCollisions(['A.ts', 'a.ts', 'safe'], true)).toEqual(['A.ts', 'a.ts']);
    expect(archivePathCollisions(['a', 'A/b', 'AB/c'], true)).toEqual(['a', 'A/b']);
    expect(archivePathCollisions(['A/b', 'a/c'], true)).toEqual(['A/b', 'a/c']);
  });
  it('保持中の展開を残し、同時刻はキー順で削除する', () => {
    const entries = [1, 2, 3, 4].map((lastUsed) => ({ key: String(lastUsed), lastUsed }));
    expect(archiveEvictions(entries, 2, new Set(['1']))).toEqual(['2', '3']);
    expect(archiveEvictions(entries, 4, new Set())).toEqual([]);
    expect(archiveEvictions(entries, 2, new Set(['1', '2', '3']))).toEqual(['4']);
    expect(archiveEvictions(entries.map((e) => ({ ...e, lastUsed: 0 })).reverse(), 2, new Set())).toEqual(['1', '2']);
  });
  it('総容量とファイル数の境界を許し、1 超過したところで拒否する', () => {
    const names = new ArchiveBudget();
    names.addPath(ARCHIVE_MAX_PATH_BYTES);
    expect(() => names.addPath(1)).toThrow('パス名の総バイト数');
    const bytes = new ArchiveBudget();
    bytes.addFile(ARCHIVE_MAX_BYTES);
    expect(() => bytes.addFile(1)).toThrow('総バイト数');
    const files = new ArchiveBudget();
    for (let i = 0; i < ARCHIVE_MAX_FILES; i++) {
      files.addFile(0);
    }
    expect(() => files.addFile(0)).toThrow('ファイル数');
    for (const size of [-1, NaN, Infinity, 1.5]) {
      expect(() => new ArchiveBudget().addFile(size)).toThrow();
    }
  });
});
