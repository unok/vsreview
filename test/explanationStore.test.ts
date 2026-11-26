import fs, { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StoredExplanation } from '../src/core/explanations';
import { EXPLANATION_MAX_COUNT, ExplanationStore } from '../src/git/explanationStore';
import { hashId, repositoryId } from '../src/git/repositoryId';
import { temporaryDirectory } from './fixtures';

const REPO = '/work/repo';
const comparison = (index: number | string): string => JSON.stringify([REPO, `commit-${index}`, 'parent', null]);
const explanation = (key: string, markdown = '# 解説'): StoredExplanation => ({
  version: 1,
  comparison: key,
  agent: 'claude',
  generatedAt: '2026-11-26T00:00:00.000Z',
  promptVersion: 1,
  files: [
    { status: 'M', path: 'a.ts', markdown },
    { status: 'A', path: 'image.png', skipped: 'binary' },
  ],
});
// 最終更新の順序を実時間に頼らず決める。
function clock(): () => number {
  let time = Date.parse('2026-11-26T00:00:00Z');
  return () => (time += 1000);
}
function repositoryDirectory(storage: string, repo = REPO): string {
  return join(storage, 'explanations', repositoryId(repo));
}

describe('ExplanationStore', () => {
  it('書いた解説を読め、新しいインスタンスでも読める', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    expect(store.persistent).toBe(true);
    await store.write(REPO, explanation(comparison(1)));
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'found', explanation: explanation(comparison(1)) });
    expect(await readdir(repositoryDirectory(storage))).toEqual([`${hashId(comparison(1))}.json`]);

    const restarted = new ExplanationStore(storage, clock());
    expect(restarted.has(REPO, comparison(1))).toBe(false);
    await restarted.load(REPO);
    expect(restarted.has(REPO, comparison(1))).toBe(true);
    expect(await restarted.read(REPO, comparison(1))).toEqual({
      kind: 'found',
      explanation: explanation(comparison(1)),
    });
  });

  it('解説のない比較は none を返し、保存先のディレクトリがなくても読み込みで失敗しない', async () => {
    const store = new ExplanationStore(await temporaryDirectory(), clock());
    await store.load(REPO);
    expect(store.has(REPO, comparison(1))).toBe(false);
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'none' });
  });

  it('保存先がなければメモリだけで保持し、新しいインスタンスでは消える', async () => {
    const store = new ExplanationStore(undefined, clock());
    expect(store.persistent).toBe(false);
    await store.write(REPO, explanation(comparison(1)));
    await store.load(REPO);
    expect(store.has(REPO, comparison(1))).toBe(true);
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'found', explanation: explanation(comparison(1)) });
    const restarted = new ExplanationStore(undefined, clock());
    expect(restarted.has(REPO, comparison(1))).toBe(false);
    expect(await restarted.read(REPO, comparison(1))).toEqual({ kind: 'none' });
  });

  it.each([
    ['JSON でない', '{'],
    ['検証に通らない', JSON.stringify({ ...explanation(comparison(1)), version: 2 })],
    ['キーが一致しない', JSON.stringify(explanation(comparison(2)))],
    ['空のファイル', ''],
  ])('%s ファイルはその比較だけ読み込めないとし、再生成で上書きできる', async (_, content) => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(3)));
    await writeFile(join(repositoryDirectory(storage), `${hashId(comparison(1))}.json`), content);
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'unreadable' });
    expect((await store.read(REPO, comparison(3))).kind).toBe('found');
    await store.write(REPO, explanation(comparison(1)));
    expect((await store.read(REPO, comparison(1))).kind).toBe('found');
  });

  it('壊れたファイルも load 後の has では保存済みとして扱い、read で読み込めないと分かる', async () => {
    const storage = await temporaryDirectory();
    await mkdir(repositoryDirectory(storage), { recursive: true });
    await writeFile(join(repositoryDirectory(storage), `${hashId(comparison(1))}.json`), '{');
    const store = new ExplanationStore(storage, clock());
    await store.load(REPO);
    expect(store.has(REPO, comparison(1))).toBe(true);
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'unreadable' });
  });

  it('外から消された解説は read で none になり、has も false になる', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(1)));
    await rm(join(repositoryDirectory(storage), `${hashId(comparison(1))}.json`));
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'none' });
    expect(store.has(REPO, comparison(1))).toBe(false);
  });

  it('ファイルとして読めない位置以外の読み取りエラーは投げる', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(1)));
    // 権限の失敗は実行ユーザーによって再現できないため、読み取りだけを失敗させる。
    vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    syncBuiltinESMExports();
    await expect(store.read(REPO, comparison(1))).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('ファイルの位置がディレクトリなら読み込めないとする', async () => {
    const storage = await temporaryDirectory();
    await mkdir(join(repositoryDirectory(storage), `${hashId(comparison(1))}.json`), { recursive: true });
    expect(await new ExplanationStore(storage, clock()).read(REPO, comparison(1))).toEqual({ kind: 'unreadable' });
  });

  it('別リポジトリ・別比較の解説を混ぜない', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    const other = JSON.stringify(['/work/other', 'commit-1', 'parent', null]);
    await store.write(REPO, explanation(comparison(1), 'repo'));
    await store.write('/work/other', explanation(other, 'other'));
    expect(store.has(REPO, other)).toBe(false);
    expect(store.has('/work/other', comparison(1))).toBe(false);
    expect(await store.read(REPO, comparison(2))).toEqual({ kind: 'none' });
    expect(await store.read('/work/other', comparison(1))).toEqual({ kind: 'none' });
    const read = await store.read('/work/other', other);
    expect(read.kind === 'found' && read.explanation.files[0]).toMatchObject({ markdown: 'other' });
  });

  it.each([true, false])(
    'リポジトリごとにちょうど上限件までは残し、超えたら最終更新の古いものから消す（保存先あり: %s）',
    async (persistent) => {
      const storage = persistent ? await temporaryDirectory() : undefined;
      const store = new ExplanationStore(storage, clock());
      expect(EXPLANATION_MAX_COUNT).toBe(50);
      for (let index = 0; index < EXPLANATION_MAX_COUNT; index++) {
        await store.write(REPO, explanation(comparison(index)));
      }
      await store.write('/work/other', explanation(JSON.stringify(['/work/other'])));
      expect(store.has(REPO, comparison(0))).toBe(true);
      // 読んだだけでは最終更新にしない。書き直した比較は新しい扱いにする。
      await store.read(REPO, comparison(0));
      await store.write(REPO, explanation(comparison(1), '再生成'));
      await store.write(REPO, explanation(comparison('new')));
      expect(store.has(REPO, comparison(0))).toBe(false);
      expect(await store.read(REPO, comparison(0))).toEqual({ kind: 'none' });
      // 次に古いのは 2。書き直した 1 は新しい扱いなので残る。
      await store.write(REPO, explanation(comparison('newer')));
      expect(store.has(REPO, comparison(2))).toBe(false);
      expect(store.has(REPO, comparison(1))).toBe(true);
      await store.write(REPO, explanation(comparison(2)));
      for (const key of [1, 2, 'new']) {
        expect(store.has(REPO, comparison(key))).toBe(true);
      }
      expect(store.has('/work/other', JSON.stringify(['/work/other']))).toBe(true);
      if (storage) {
        expect(await readdir(repositoryDirectory(storage))).toHaveLength(EXPLANATION_MAX_COUNT);
      }
    },
  );

  it('保存した解説や一時ファイルと同じ形の名前のディレクトリは、件数・削除・掃除の対象にしない', async () => {
    const storage = await temporaryDirectory();
    const directory = repositoryDirectory(storage);
    const lookalike = `${hashId(comparison('dir'))}.json`;
    await mkdir(join(directory, lookalike, 'child'), { recursive: true });
    await mkdir(join(directory, '.tmp-dir', 'child'), { recursive: true });
    const store = new ExplanationStore(storage, clock());
    await store.load(REPO);
    expect(store.has(REPO, comparison('dir'))).toBe(false);
    for (let index = 0; index <= EXPLANATION_MAX_COUNT; index++) {
      await store.write(REPO, explanation(comparison(index)));
    }
    expect(store.has(REPO, comparison(0))).toBe(false);
    expect(store.has(REPO, comparison(1))).toBe(true);
    const names = await readdir(directory);
    expect(names).toEqual(expect.arrayContaining([lookalike, '.tmp-dir']));
    expect(names).toHaveLength(EXPLANATION_MAX_COUNT + 2);
  });

  it('件数の整理中に他から消されたファイルがあっても書き込みは成功する', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    for (let index = 0; index < EXPLANATION_MAX_COUNT; index++) {
      await store.write(REPO, explanation(comparison(index)));
    }
    const removed = join(repositoryDirectory(storage), `${hashId(comparison(0))}.json`);
    const lstat = fs.lstat;
    let raced = false;
    // 一覧の取得後・最終更新の取得前に消えた状況を作る。
    vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      if (path === removed) {
        raced = true;
        await rm(removed, { force: true });
      }
      return lstat(path, options);
    });
    syncBuiltinESMExports();
    await store.write(REPO, explanation(comparison('new')));
    expect(raced).toBe(true);
    expect(store.has(REPO, comparison(0))).toBe(false);
    expect(store.has(REPO, comparison('new'))).toBe(true);
    expect(await readdir(repositoryDirectory(storage))).toHaveLength(EXPLANATION_MAX_COUNT);
  });

  it('件数の整理で消えた比較を、同時の読み込みが索引に戻さない', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    for (let index = 0; index < EXPLANATION_MAX_COUNT; index++) {
      await store.write(REPO, explanation(comparison(index)));
    }
    const [, read] = await Promise.all([
      store.write(REPO, explanation(comparison('new'))),
      store.read(REPO, comparison(0)),
    ]);
    expect(read).toEqual({ kind: 'none' });
    expect(store.has(REPO, comparison(0))).toBe(false);
  });

  it('書き込み途中の一時ファイルが残っていても読み込みと件数を誤らず、読み込み時に掃除する', async () => {
    const storage = await temporaryDirectory();
    const directory = repositoryDirectory(storage);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.tmp-interrupted'), '{"version":');
    await writeFile(join(directory, 'unrelated.txt'), 'x');
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(1)));
    expect((await store.read(REPO, comparison(1))).kind).toBe('found');
    await store.load(REPO);
    expect((await readdir(directory)).sort()).toEqual([`${hashId(comparison(1))}.json`, 'unrelated.txt'].sort());
  });

  it('同じ比較への同時の書き込みは壊れず、最後の内容になる', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await Promise.all(['1', '2', '3'].map((text) => store.write(REPO, explanation(comparison(1), text))));
    const [read] = await Promise.all([store.read(REPO, comparison(1)), store.write(REPO, explanation(comparison(1)))]);
    expect(read.kind).toBe('found');
    const final = await store.read(REPO, comparison(1));
    expect(final.kind === 'found' && final.explanation.files[0]).toMatchObject({ markdown: '# 解説' });
    expect(await readdir(repositoryDirectory(storage))).toHaveLength(1);
  });

  it('パスに使えない文字を含むキーもハッシュ化して保存する', async () => {
    const storage = await temporaryDirectory();
    const key = JSON.stringify(['C:\\repo', '../..', 'a/b:c*?"<>|\n\0', null]);
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(key));
    expect((await store.read(REPO, key)).kind).toBe('found');
    expect(await readdir(repositoryDirectory(storage))).toEqual([`${hashId(key)}.json`]);
  });

  it('保存先のディレクトリが作れないときは書き込みを失敗にする', async () => {
    const storage = join(await temporaryDirectory(), 'file');
    await writeFile(storage, 'not a directory');
    await expect(new ExplanationStore(storage, clock()).write(REPO, explanation(comparison(1)))).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
    expect(await readFile(storage, 'utf8')).toBe('not a directory');
  });

  it('リポジトリのディレクトリの位置がファイルなら load と write を失敗にする', async () => {
    const storage = await temporaryDirectory();
    await mkdir(join(storage, 'explanations'));
    await writeFile(repositoryDirectory(storage), 'file');
    const store = new ExplanationStore(storage, clock());
    await expect(store.load(REPO)).rejects.toThrow('保存先がディレクトリではありません');
    await expect(store.write(REPO, explanation(comparison(1)))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(repositoryDirectory(storage), 'utf8')).toBe('file');
  });

  it.each([
    [
      'explanations',
      (storage: string) => join(storage, 'explanations'),
      (target: string) => join(target, repositoryId(REPO)),
    ],
    ['リポジトリ単位のディレクトリ', (storage: string) => repositoryDirectory(storage), (target: string) => target],
  ])('保存先の %s がシンボリックリンクならリンク先を読まず、消さず、書き込まない', async (_, link, saved) => {
    const storage = await temporaryDirectory();
    const target = await temporaryDirectory();
    const directory = saved(target);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '.tmp-interrupted'), 'x');
    await writeFile(join(directory, `${hashId(comparison(1))}.json`), JSON.stringify(explanation(comparison(1))));
    const before = (await readdir(directory)).sort();
    await mkdir(join(link(storage), '..'), { recursive: true });
    await symlink(target, link(storage), 'dir');
    const store = new ExplanationStore(storage, clock());
    await expect(store.load(REPO)).rejects.toThrow('保存先がディレクトリではありません');
    await expect(store.read(REPO, comparison(1))).rejects.toThrow('保存先がディレクトリではありません');
    await expect(store.write(REPO, explanation(comparison(2)))).rejects.toThrow('保存先がディレクトリではありません');
    expect(store.has(REPO, comparison(1))).toBe(false);
    expect((await readdir(directory)).sort()).toEqual(before);
  });

  it('解説のファイルの位置がシンボリックリンクならリンク先を読まない', async () => {
    const storage = await temporaryDirectory();
    const target = join(await temporaryDirectory(), 'explanation.json');
    await writeFile(target, JSON.stringify(explanation(comparison(1))));
    await mkdir(repositoryDirectory(storage), { recursive: true });
    await symlink(target, join(repositoryDirectory(storage), `${hashId(comparison(1))}.json`));
    expect(await new ExplanationStore(storage, clock()).read(REPO, comparison(1))).toEqual({ kind: 'unreadable' });
  });

  it.each([true, false])('待たない書き込みの直後の読み込みは書いた値を返す（保存先あり: %s）', async (persistent) => {
    const store = new ExplanationStore(persistent ? await temporaryDirectory() : undefined, clock());
    const written = Promise.all([
      store.write(REPO, explanation(comparison(1), '古い解説')),
      store.write(REPO, explanation(comparison(1), '新しい解説')),
    ]);
    expect(await store.read(REPO, comparison(1))).toEqual({
      kind: 'found',
      explanation: explanation(comparison(1), '新しい解説'),
    });
    await written;
  });

  it('保存先に書けないときは書き込みを失敗にし、既存の内容を残して一時ファイルを残さない', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(1), '元の解説'));
    // 保存先のファイルの位置に空でないディレクトリがあると、差し替えに失敗する。
    const blocked = join(repositoryDirectory(storage), `${hashId(comparison(2))}.json`);
    await mkdir(join(blocked, 'child'), { recursive: true });
    const failure = await store.write(REPO, explanation(comparison(2))).then(
      () => undefined,
      (error: unknown) => error as NodeJS.ErrnoException,
    );
    // rename でディレクトリを置き換えられないときのコードは OS によって異なる。
    expect(['EISDIR', 'ENOTEMPTY', 'EPERM', 'EEXIST']).toContain(failure?.code);
    const read = await store.read(REPO, comparison(1));
    expect(read.kind === 'found' && read.explanation.files[0]).toMatchObject({ markdown: '元の解説' });
    expect(store.has(REPO, comparison(2))).toBe(false);
    expect((await readdir(repositoryDirectory(storage))).sort()).toEqual(
      [`${hashId(comparison(1))}.json`, `${hashId(comparison(2))}.json`].sort(),
    );
    // 失敗の後も書き込みを続けられる。
    await store.write(REPO, explanation(comparison(3)));
    expect(store.has(REPO, comparison(3))).toBe(true);
  });

  it('形式が不正な解説は書き込まず、既存の内容を残す', async () => {
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage, clock());
    await store.write(REPO, explanation(comparison(1)));
    expect(store.has(REPO, comparison(1))).toBe(true);
    await expect(store.write(REPO, { ...explanation(comparison(1)), version: 2 } as never)).rejects.toThrow(
      '保存する解説の形式が不正です',
    );
    expect(await store.read(REPO, comparison(1))).toEqual({ kind: 'found', explanation: explanation(comparison(1)) });
    expect(await readdir(repositoryDirectory(storage))).toHaveLength(1);
  });

  it.each([true, false])(
    '書き込み待ちの間や読み戻し後に値を変更しても保存内容は変わらない（保存先あり: %s）',
    async (persistent) => {
      const store = new ExplanationStore(persistent ? await temporaryDirectory() : undefined, clock());
      const value = explanation(comparison(1), '元の解説');
      const written = store.write(REPO, value);
      value.files[0] = { status: 'M', path: 'a.ts', markdown: '変更後' };
      await written;
      const read = await store.read(REPO, comparison(1));
      expect(read).toEqual({ kind: 'found', explanation: explanation(comparison(1), '元の解説') });
      if (read.kind === 'found') {
        read.explanation.files.length = 0;
      }
      expect(await store.read(REPO, comparison(1))).toEqual({
        kind: 'found',
        explanation: explanation(comparison(1), '元の解説'),
      });
    },
  );
});
