import { describe, expect, it } from 'vitest';
import { compactFolders, displayedFileTree } from '../src/ui/fileView';
import { globalConfiguration, workspaceFolderConfiguration, Uri } from './vscodeMock';

describe('fileView', () => {
  it.each([
    [undefined, true],
    [null, true],
    ['', true],
    [0, true],
    ['false', true],
    [true, true],
    [false, false],
  ])('compactFolders は false だけで圧縮を解除する: %s', (value, expected) => {
    globalConfiguration.set('explorer.compactFolders', value);
    expect(compactFolders()).toBe(expected);
  });

  it('リポジトリごとのcompactFoldersでフォルダの表示を切り替える', () => {
    const repo = '/repo';
    const files = [{ path: 'src/ui/file.ts', status: 'M' as const }];
    globalConfiguration.set('explorer.compactFolders', true);
    workspaceFolderConfiguration.set(Uri.file(repo).toString(), new Map([['explorer.compactFolders', false]]));
    expect(displayedFileTree(files, repo)[0]?.name).toBe('src');
    expect(displayedFileTree(files, '/other')[0]?.name).toBe('src/ui');
    expect(displayedFileTree([], repo)).toEqual([]);
  });
});
