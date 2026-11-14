import { describe, expect, it } from 'vitest';
import {
  statusDecoration,
  folderStatus,
  statusUriParts,
  parseStatusUri,
  type StatusResource,
} from '../src/core/decorations';
import { StatusDecorationProvider, statusUri } from '../src/ui/decorations';
import { ThemeColor, Uri } from './vscodeMock';

const resource: StatusResource = {
  repo: '/repo 日本語',
  commit: 'a'.repeat(40),
  side: 'new',
  kind: 'file',
  path: '日本語 空白/#?%.ts',
  status: 'R',
};

describe('decorations', () => {
  it.each([
    ['A', 'added', '追加'],
    ['M', 'modified', '変更'],
    ['D', 'deleted', '削除'],
    ['R', 'renamed', 'リネーム'],
    ['C', 'added', 'コピー'],
    ['T', 'modified', '種類変更'],
    ['U', 'conflicting', '競合'],
  ] as const)('%s のバッジ・色・状態名を返す', (status, color, tooltip) => {
    expect(statusDecoration({ ...resource, status })).toEqual({
      badge: status,
      color: `gitDecoration.${color}ResourceForeground`,
      tooltip,
    });
    expect(statusDecoration({ ...resource, kind: 'folder', status })).toEqual({
      color: `gitDecoration.${color}ResourceForeground`,
    });
  });
  it('未変更は装飾せず、URIは特殊文字を保持して側・種別・コミット・repoを区別する', () => {
    const parts = statusUriParts(resource);
    expect(parts.path).toBe(`/${resource.path}`);
    expect(parseStatusUri(parts)).toEqual(resource);
    expect(statusDecoration({ ...resource, status: undefined })).toBeUndefined();
    const refs = [
      resource,
      { ...resource, side: 'old' as const },
      { ...resource, kind: 'folder' as const },
      { ...resource, commit: 'b'.repeat(40) },
      { ...resource, repo: '/other' },
    ];
    expect(new Set(refs.map((ref) => JSON.stringify(statusUriParts(ref)))).size).toBe(refs.length);
    expect(parseStatusUri(statusUriParts({ ...resource, kind: 'folder', path: '' }))).toEqual({
      ...resource,
      kind: 'folder',
      path: '',
    });
  });
  it.each([
    { scheme: 'vsreview', path: '/a', query: '{}' },
    { scheme: 'vsreview-status', path: '/a', query: '' },
    { scheme: 'vsreview-status', path: '/a', query: 'null' },
    ...[
      { repo: '' },
      { repo: 1 },
      { status: null },
      { side: undefined },
      { kind: undefined },
      { commit: 'HEAD' },
      { side: 'both' },
      { kind: 'unknown' },
      { status: 'X' },
    ].map((patch) => ({
      ...statusUriParts(resource),
      query: new URLSearchParams({ ref: JSON.stringify({ ...resource, ...patch }) }).toString(),
    })),
    ...['/', '/../file', '/a//b', '/./file', '/a\0b', 'relative'].map((path) => ({
      ...statusUriParts(resource),
      path,
    })),
  ])('不明・壊れたURIを無視する: %j', (uri) => {
    expect(parseStatusUri(uri)).toBeUndefined();
    expect(new StatusDecorationProvider().provideFileDecoration(Uri.from(uri))).toBeUndefined();
  });
  it('フォルダ境界・空集合・子孫の混在を扱う', () => {
    const changes = new Map([
      ['src/deep/one', { path: 'src/deep/one', status: 'R' as const }],
      ['src/two', { path: 'src/two', status: 'A' as const }],
      ['src2/three', { path: 'src2/three', status: 'D' as const }],
    ]);
    expect(folderStatus('src/deep', changes)).toBe('R');
    expect(folderStatus('src', changes)).toBe('M');
    expect(folderStatus('sr', changes)).toBeUndefined();
    expect(folderStatus('', new Map())).toBeUndefined();
    expect(folderStatus('', changes)).toBe('M');
  });
  it('ルート直下と同じパスの両側を区別し、空のフォルダは装飾しない', () => {
    const old = statusUri({ ...resource, path: 'file.ts', side: 'old', status: 'D' });
    const current = statusUri({ ...resource, path: 'file.ts', side: 'new', status: 'A' });
    expect(old.toString()).not.toBe(current.toString());
    const provider = new StatusDecorationProvider();
    expect(provider.provideFileDecoration(old)?.badge).toBe('D');
    expect(provider.provideFileDecoration(current)?.badge).toBe('A');
    expect(
      provider.provideFileDecoration(statusUri({ ...resource, path: '', kind: 'folder', status: undefined })),
    ).toBeUndefined();
  });
  it.each(['{', 'null', '[]', '1', '"text"', '{}'])('不正なメタデータで例外を投げない: %s', (query) => {
    expect(
      new StatusDecorationProvider().provideFileDecoration({
        ...statusUriParts(resource),
        query: new URLSearchParams({ ref: query }).toString(),
      }),
    ).toBeUndefined();
  });
  it('Providerはファイル・フォルダ・未変更を返し、実URIでも往復できる', () => {
    const provider = new StatusDecorationProvider();
    const uri = statusUri(resource);
    expect(parseStatusUri(uri)).toEqual(resource);
    expect(provider.provideFileDecoration(uri)).toEqual({
      badge: 'R',
      color: new ThemeColor('gitDecoration.renamedResourceForeground'),
      tooltip: 'リネーム',
    });
    expect(provider.provideFileDecoration(statusUri({ ...resource, kind: 'folder' }))).toEqual({
      color: new ThemeColor('gitDecoration.renamedResourceForeground'),
    });
    expect(provider.provideFileDecoration(statusUri({ ...resource, status: undefined }))).toBeUndefined();
  });
});
