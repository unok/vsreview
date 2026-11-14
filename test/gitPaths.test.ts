import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isCaseInsensitiveFilesystem, isNormalizationInsensitiveFilesystem } from '../src/git/paths';
import { temporaryDirectory } from './fixtures';

describe('gitPaths', () => {
  it.each(['EACCES', 'EEXIST'])('検査ファイルの作成失敗 %s を伝える', async (code) => {
    const directory = await temporaryDirectory();
    vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('probe failed'), { code }));
    syncBuiltinESMExports();
    await expect(isCaseInsensitiveFilesystem(directory)).rejects.toMatchObject({ code });
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('別名の検査が ENOENT 以外で失敗したら伝え、検査ファイルを消す', async () => {
    const directory = await temporaryDirectory();
    vi.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    syncBuiltinESMExports();
    await expect(isNormalizationInsensitiveFilesystem(directory)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('実ファイルで大小文字を検査し、検査用ファイルを残さない', async () => {
    const directory = await temporaryDirectory();
    expect(typeof (await isCaseInsensitiveFilesystem(directory))).toBe('boolean');
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('大文字でも見つかるファイルシステムを検出し、検査用ファイルを残さない', async () => {
    const directory = await temporaryDirectory();
    const lstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((path, options) =>
      lstat(join(dirname(String(path)), basename(String(path)).toLowerCase()), options),
    );
    syncBuiltinESMExports();
    expect(await isCaseInsensitiveFilesystem(directory)).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('正規化の綴りで同一視するファイルシステムを検出し、検査用ファイルを残さない', async () => {
    const directory = await temporaryDirectory();
    const lstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((path, options) => lstat(String(path).normalize('NFC'), options));
    syncBuiltinESMExports();
    expect(await isNormalizationInsensitiveFilesystem(directory)).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each([
    ['大小文字', isCaseInsensitiveFilesystem],
    ['正規化', isNormalizationInsensitiveFilesystem],
  ])('別の綴りが存在しなければ%sを同一視せず、検査用ファイルを残さない', async (_name, probe) => {
    const directory = await temporaryDirectory();
    vi.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('missing alias'), { code: 'ENOENT' }));
    syncBuiltinESMExports();
    expect(await probe(directory)).toBe(false);
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
