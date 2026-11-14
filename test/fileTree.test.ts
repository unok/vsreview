import { describe, expect, it } from 'vitest';
import { buildFileTree, flattenFileTree } from '../src/core/fileTree';
import type { ChangedFile } from '../src/core/gitParsing';
const file = (path: string): ChangedFile => ({ path, status: 'M' });
describe('fileTree', () => {
  it('大文字を小文字より前に並べる', () => {
    expect(flattenFileTree(buildFileTree([file('a'), file('B')], false)).map((file) => file.path)).toEqual(['B', 'a']);
  });
  it('空とルート直下を扱い、入力を変更しない', () => {
    expect(buildFileTree([], true)).toEqual([]);
    const files = [file('z'), file('a')];
    expect(flattenFileTree(buildFileTree(files, true))).toEqual([files[1], files[0]]);
    expect(files.map((f) => f.path)).toEqual(['z', 'a']);
  });
  it('フォルダを先に名前順で並べ、同名ファイルと区別する', () => {
    const tree = buildFileTree([file('z'), file('a'), file('a/z'), file('b/z'), file('a/a')], false);
    expect(tree.map((n) => [n.kind, n.name])).toEqual([
      ['folder', 'a'],
      ['folder', 'b'],
      ['file', 'a'],
      ['file', 'z'],
    ]);
    expect(flattenFileTree(tree).map((f) => f.path)).toEqual(['a/a', 'a/z', 'b/z', 'a', 'z']);
  });
  it('単一フォルダだけを圧縮し、分岐や単一ファイルで止める', () => {
    const files = [file('src/ui/deep/a.ts'), file('src/ui/deep/b.ts')];
    expect(buildFileTree(files, true)[0]).toMatchObject({
      name: 'src/ui/deep',
      path: 'src/ui/deep',
      paths: ['src/ui/deep/a.ts', 'src/ui/deep/b.ts'],
    });
    const expanded = buildFileTree(files, false)[0];
    expect(expanded).toMatchObject({ name: 'src', children: [{ name: 'ui', children: [{ name: 'deep' }] }] });
    expect(buildFileTree([file('src/a'), file('src/ui/b')], true)[0]).toMatchObject({ name: 'src' });
    expect(buildFileTree([file('src/a')], true)[0]).toMatchObject({ name: 'src', children: [{ name: 'a' }] });
    expect(flattenFileTree(buildFileTree(files, true))).toEqual(flattenFileTree(buildFileTree(files, false)));
  });
  it('リネーム・コピーを新パスに置き、日本語・空白と旧パスを保持する', () => {
    const files: ChangedFile[] = [
      { status: 'R', path: '新 規/日本語.ts', oldPath: 'old/a.ts' },
      { status: 'C', path: '新 規/copy.ts', oldPath: 'elsewhere/b.ts' },
    ];
    const tree = buildFileTree(files, true);
    expect(tree).toMatchObject([{ name: '新 規', children: [{ name: 'copy.ts' }, { name: '日本語.ts' }] }]);
    expect(flattenFileTree(tree)).toEqual([files[1], files[0]]);
  });
});
