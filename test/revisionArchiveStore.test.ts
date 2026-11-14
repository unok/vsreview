import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { ARCHIVE_MAX_BYTES } from '../src/core/revisionArchive';
import { describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, readFile, readdir, symlink, writeFile, rm, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { repository, temporaryDirectory, archiveClock } from './fixtures';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { GitClient, runGit } from '../src/git/client';
import { RevisionArchiveStore, LINK_PATH_CONCURRENCY } from '../src/git/revisionArchiveStore';
import { repositoryId } from '../src/git/repositoryId';

describe('revisionArchiveStore', () => {
  it('不正なツリーパスだけを除外し、安全なファイルを展開して一度通知する', async () => {
    const { directory, git } = await repository();
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'safe')).toString().trim();
    const tree = (
      await runGit(
        directory,
        ['mktree', '-z'],
        ['..', '.', 'safe'].map((path) => `100644 blob ${hash}\t${path}\0`).join(''),
      )
    )
      .toString()
      .trim();
    const warning = vi.fn();
    const root = await new RevisionArchiveStore(await temporaryDirectory(), warning).get(git, tree, []);
    expect(await readdir(root)).toEqual(['safe']);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('safe');
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('安全でないパス'));
  });
  it('Windows の書けないパスを解析後に個別除外し、一度だけ通知する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'safe'), 'valid');
    await commitAll(directory, 'safe');
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'invalid')).toString().trim();
    const paths = ['a\\b', 'C:drive', 'a<', 'a>', 'a"', 'a|', 'a?', 'a*', 'a\u0001', 'a.', 'a ', 'CON', 'LONGNA~1.txt'];
    const safe = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'valid')).toString().trim();
    const tree = (
      await runGit(
        directory,
        ['mktree', '-z'],
        [...paths.map((path) => `100644 blob ${hash}\t${path}\0`), `100644 blob ${safe}\tsafe\0`].join(''),
      )
    )
      .toString()
      .trim();
    const warning = vi.fn();
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      undefined,
      undefined,
      undefined,
      'win32',
    );
    const root = await store.get(git, tree, []);
    expect(await readdir(root)).toEqual(['safe']);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('valid');
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('安全でないパス'));
  });
  it('書けない長いパスの blob を読み飛ばし、後続の内容を保つ', async () => {
    const { directory, git } = await repository();
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'body')).toString().trim();
    const tree = (
      await runGit(
        directory,
        ['mktree'],
        `100644 blob ${hash}\t${'a'.repeat(256)}\n100644 blob ${hash}\t${'b'.repeat(256)}\n100644 blob ${hash}\tz-safe\n`,
      )
    )
      .toString()
      .trim();
    const warning = vi.fn();
    const root = await new RevisionArchiveStore(await temporaryDirectory(), warning).get(git, tree, []);
    expect(await readdir(root)).toEqual(['z-safe']);
    expect(await readFile(join(root, 'z-safe'), 'utf8')).toBe('body');
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('保存先で利用できないパス'));
  });
  it('欠けた複数 blob をフェッチせず除外し、後続を展開して一度通知する', async () => {
    const { directory, git } = await repository();
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'safe')).toString().trim();
    const tree = (
      await runGit(
        directory,
        ['mktree', '--missing'],
        `100644 blob ${'a'.repeat(40)}\ta\n100644 blob ${'b'.repeat(40)}\tb\n100644 blob ${hash}\tz-safe\n`,
      )
    )
      .toString()
      .trim();
    const warning = vi.fn();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    const root = await store.get(git, tree, []);
    expect(await store.valid(root, directory)).toBe(true);
    expect((await readdir(dirname(root))).some((name) => name.startsWith('.tmp-'))).toBe(false);
    expect(await readFile(join(root, 'z-safe'), 'utf8')).toBe('safe');
    expect(await readdir(root)).toEqual(['z-safe']);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('欠けた blob'));
  });
  it('大小文字だけを同一視する保存先では NFC/NFD の両方を保つ', async () => {
    const { directory, git } = await repository();
    for (const path of ['é.ts', 'e\u0301.ts']) {
      await writeFile(join(directory, path), path);
    }
    await commitAll(directory, 'normalization sensitive');
    const warning = vi.fn();
    const root = await new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      () => Promise.resolve(true),
      Date.now,
      () => Promise.resolve(false),
    ).get(git, (await git.head())!, []);
    expect(await readFile(join(root, 'é.ts'), 'utf8')).toBe('é.ts');
    expect(await readFile(join(root, 'e\u0301.ts'), 'utf8')).toBe('e\u0301.ts');
    expect(warning).not.toHaveBeenCalled();
  });
  it('実行可能な通常ファイルの objects と refs もベア構成から除く', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'bare'));
    for (const path of ['HEAD', 'objects', 'refs']) {
      await writeFile(join(directory, 'bare', path), 'data');
      await chmod(join(directory, 'bare', path), 0o755);
    }
    await writeFile(join(directory, 'safe'), 'safe');
    await commitAll(directory, 'bare files');
    const warning = vi.fn();
    const root = await new RevisionArchiveStore(await temporaryDirectory(), warning).get(git, (await git.head())!, []);
    expect(await readdir(join(root, 'bare'))).toEqual([]);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('safe');
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ベアリポジトリ'));
  });
  it('履歴の大小文字別名と重なるリンクを作らず理由を通知する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'Vendor'), 'history');
    await commitAll(directory, 'vendor');
    await mkdir(join(directory, 'vendor'));
    await writeFile(join(directory, 'vendor/x'), 'working');
    const warning = vi.fn();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning, () => Promise.resolve(true));
    const root = await store.get(git, (await git.head())!, ['vendor/x']);
    expect(await store.links(root)).toEqual([]);
    expect(await readFile(join(root, 'Vendor'), 'utf8')).toBe('history');
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('履歴のパスと重複'));
  });
  it('並行要求で日本語のファイルを展開してシンボリックリンクを除く', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, '日本 語.ts'), 'old\n');
    await symlink('/outside', join(directory, 'link'));
    await commitAll(directory, 'initial');
    const rev = (await git.head())!;
    const storage = await temporaryDirectory();
    const store = new RevisionArchiveStore(storage);
    const [first, second] = await Promise.all([store.get(git, rev, []), store.get(git, rev, [])]);
    expect(first).toBe(second);
    expect(await readFile(join(first, '日本 語.ts'), 'utf8')).toBe('old\n');
    expect((await lstat(join(first, '日本 語.ts'))).mode & 0o222).toBe(0);
    await expect(lstat(join(first, 'link'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new RevisionArchiveStore(storage).get(git, rev, [])).toBe(first);
    await expect(store.get(git, 'f'.repeat(40), [])).rejects.toThrow();
    expect(
      (await readdir(join(storage, 'revisionArchives', repositoryId(directory)))).some((name) =>
        name.startsWith('.tmp-'),
      ),
    ).toBe(false);
  });
  it('未完了の展開を掃除し、設定された既存パスだけリンクする', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'value');
    await commitAll(directory, 'initial');
    const rev = (await git.head())!;
    const storage = await temporaryDirectory();
    const parent = join(storage, 'revisionArchives', repositoryId(directory));
    await mkdir(join(parent, '.tmp-abandoned'), { recursive: true });
    await mkdir(join(parent, rev));
    await writeFile(join(parent, rev, 'partial'), 'bad');
    await mkdir(join(directory, 'node_modules'));
    const store = new RevisionArchiveStore(storage);
    await store.initialize();
    expect(await readdir(parent)).toEqual([]);
    const root = await store.get(git, rev, ['node_modules', 'missing']);
    expect((await lstat(join(root, 'node_modules'))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, 'partial'))).rejects.toMatchObject({ code: 'ENOENT' });
    const fresh = new RevisionArchiveStore(storage);
    expect(await fresh.get(git, rev, [])).toBe(root);
  });
  it('書き込み途中の中断を後始末し、再要求で展開し直す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'source');
    await commitAll(directory, 'root');
    const rev = (await git.head())!;
    const storage = await temporaryDirectory();
    const store = new RevisionArchiveStore(storage);
    class InterruptedGit extends GitClient {
      override expandRevision(
        rev: string,
        write: Parameters<GitClient['expandRevision']>[1],
        include: Parameters<GitClient['expandRevision']>[2],
        entries: Parameters<GitClient['expandRevision']>[3],
      ) {
        return super.expandRevision(
          rev,
          async (entry, body) => {
            await write(entry, body);
            throw new Error('interrupted');
          },
          include,
          entries,
        );
      }
    }
    await expect(store.get(new InterruptedGit(directory), rev, [])).rejects.toThrow('interrupted');
    expect(await readdir(join(storage, 'revisionArchives', repositoryId(directory)))).toEqual([]);
    const root = await store.get(git, rev, []);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('source');
  });
  it('属性の export-ignore と export-subst の影響を受けず blob を保つ', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, '.gitattributes'), 'hidden.ts export-ignore\nchanged.ts export-subst\n');
    await writeFile(join(directory, 'hidden.ts'), 'export const hidden = 1;');
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested/.gitattributes'), '* export-ignore\n');
    await writeFile(join(directory, 'nested/file.ts'), 'nested');
    await writeFile(join(directory, 'changed.ts'), '$Format:%H$');
    await commitAll(directory, 'attributes');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, []);
    expect(await readFile(join(root, 'hidden.ts'), 'utf8')).toBe('export const hidden = 1;');
    expect(await readFile(join(root, 'changed.ts'), 'utf8')).toBe('$Format:%H$');
    expect(await readFile(join(root, 'nested/file.ts'), 'utf8')).toBe('nested');
  });
  it('長いパスとルートコミットの空ツリーを展開する', async () => {
    const { directory, git } = await repository();
    const nested = '日本 語'.repeat(20);
    await mkdir(join(directory, nested));
    await writeFile(join(directory, nested, 'source.ts'), 'source');
    await commitAll(directory, 'root');
    const commit = (await git.log(0, 1))[0]!;
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, commit.hash, []);
    expect(await readFile(join(root, nested, 'source.ts'), 'utf8')).toBe('source');
    expect(await readdir(await store.get(git, await git.parent(commit), []))).toEqual([]);
  });
  it('明示した使用時刻で LRU を選び、保持中を残して全削除する', async () => {
    archiveClock();
    const { directory, git } = await repository();
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const roots: string[] = [];
    for (let i = 0; i < 3; i++) {
      await writeFile(join(directory, 'file'), String(i));
      await commitAll(directory, String(i));
      roots.push(await store.get(git, (await git.head())!, []));
    }
    await store.prune(2, new Set([roots[0]!]));
    await expect(lstat(roots[0]!)).resolves.toBeDefined();
    await expect(lstat(roots[1]!)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(roots[2]!)).resolves.toBeDefined();
    await store.clear();
    await expect(lstat(roots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['missing-root', 'broken-json', 'wrong-repo', 'invalid-links', 'unresolved-pattern'])(
    '完了情報 %s を不完全とみなし再展開する',
    async (scenario) => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'source');
      await commitAll(directory, 'initial');
      const rev = (await git.head())!;
      const store = new RevisionArchiveStore(await temporaryDirectory());
      const root = await store.get(git, rev, []);
      if (scenario === 'missing-root') {
        await rm(root, { recursive: true });
      } else {
        await rm(join(root, 'file'));
        await writeFile(
          `${root}.complete`,
          scenario === 'broken-json'
            ? '{'
            : JSON.stringify({
                repo: scenario === 'wrong-repo' ? '/other' : directory,
                links: scenario === 'wrong-repo' ? [] : scenario === 'unresolved-pattern' ? ['**/deps'] : ['../unsafe'],
              }),
        );
      }
      expect(await readFile(join(await store.get(git, rev, []), 'file'), 'utf8')).toBe('source');
      expect(await store.valid(root, directory)).toBe(true);
      expect(await store.links(root)).toEqual([]);
    },
  );
  it('リンク元の途中がリポジトリ外を指す場合はリンクだけ除いて通知する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'data');
    await commitAll(directory, 'empty');
    const outside = await temporaryDirectory();
    await mkdir(join(outside, 'modules'));
    await symlink(outside, join(directory, 'vendor'));
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    const rev = (await git.head())!;
    const root = await store.get(git, rev, ['vendor/modules']);
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('data');
    await expect(lstat(join(root, 'vendor/modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('同名の履歴ファイルを上書きせず、未追跡ファイルもリンクできる', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'vendor'));
    await writeFile(join(directory, 'vendor/source'), 'historical');
    await commitAll(directory, 'initial');
    await writeFile(join(directory, 'local.txt'), 'current');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, ['vendor', 'local.txt']);
    expect((await lstat(join(root, 'vendor'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(root, 'local.txt'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(root, 'local.txt'), 'utf8')).toBe('current');
  });
  it('POSIX のコロン・バックスラッシュ、空ファイル、実行ビットを保つ', async () => {
    const { directory, git } = await repository();
    for (const path of ['a:b', 'a\\b', 'empty']) {
      await writeFile(join(directory, path), '');
    }
    const binary = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 256));
    await writeFile(join(directory, 'binary'), binary);
    await writeFile(join(directory, 'run'), '#!/bin/sh\n');
    await chmod(join(directory, 'run'), 0o755);
    await commitAll(directory, 'paths');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, []);
    expect(await readFile(join(root, 'binary'))).toEqual(binary);
    expect(await readFile(join(root, 'a:b'), 'utf8')).toBe('');
    expect(await readFile(join(root, 'a\\b'), 'utf8')).toBe('');
    expect((await lstat(join(root, 'run'))).mode & 0o111).toBe(0o111 & ~process.umask());
    expect((await lstat(join(root, 'run'))).mode & 0o222).toBe(0);
    expect((await lstat(join(root, 'empty'))).mode & 0o777).toBe(0o666 & ~process.umask() & ~0o222);
  });
  it('埋め込みベアリポジトリの中身を公開せずディレクトリ名を保つ', async () => {
    const { directory, git } = await repository();
    for (const path of ['nested/bare/objects/info', 'nested/bare/refs/heads']) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(join(directory, path, 'entry'), 'data');
    }
    for (const path of ['nested/bare/HEAD', 'nested/bare/config', 'safe']) {
      await writeFile(join(directory, path), 'data');
    }
    await commitAll(directory, 'bare');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, []);
    expect(await readdir(join(root, 'nested/bare'))).toEqual([]);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('data');
  });
  it.each(['bytes', 'duplicate', 'unsafe'])(
    '展開の %s 違反で中止し、完成済みも一時ファイルも残さない',
    async (scenario) => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'initial'), 'data');
      await commitAll(directory, 'initial');
      const rev = (await git.head())!;
      // 巨大ファイルを作らず、同じ公開入口にサイズ付き blob を流す。
      const source = new GitClient(directory);
      vi.spyOn(source, 'expandRevision').mockImplementation(async (_rev, write) => {
        const entries = scenario === 'duplicate' ? 2 : 1;
        for (let i = 0; i < entries; i++) {
          await write(
            {
              path: scenario === 'unsafe' ? '../escape' : 'file',
              size: scenario === 'bytes' ? ARCHIVE_MAX_BYTES + 1 : 0,
              executable: false,
            },
            () => Promise.resolve(),
          );
        }
      });
      const store = new RevisionArchiveStore(await temporaryDirectory());
      await expect(store.get(source, rev, [])).rejects.toThrow(
        scenario === 'bytes' ? '総バイト数' : scenario === 'duplicate' ? 'EEXIST' : '展開先のパスが不正',
      );
      expect(await store.valid(store.rootFor(directory, rev), directory)).toBe(false);
      expect(await readdir(join(store.rootFor(directory, rev), '..'))).toEqual([]);
    },
  );
  it('並行した要求は同じ展開失敗を受け、次の要求で再試行できる', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'data');
    await commitAll(directory, 'initial');
    const rev = (await git.head())!;
    const store = new RevisionArchiveStore(await temporaryDirectory());
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failure = new Error('interrupted');
    vi.spyOn(git, 'expandRevision').mockImplementationOnce(async () => {
      await gate;
      throw failure;
    });
    const results = Promise.allSettled([store.get(git, rev, []), store.get(git, rev, [])]);
    release();
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(await readFile(join(await store.get(git, rev, []), 'file'), 'utf8')).toBe('data');
  });
  it('umask 077 で作ったファイルに他ユーザーの読み取り権限を足さない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'secret');
    await commitAll(directory, 'initial');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const previous = process.umask(0o077);
    try {
      const root = await store.get(git, (await git.head())!, []);
      expect((await lstat(join(root, 'file'))).mode & 0o777).toBe(0o400);
    } finally {
      process.umask(previous);
    }
  });
  it('gitlink を実ファイルとして書き出さない', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'data');
    await commitAll(directory, 'initial');
    const parent = (await git.head())!;
    await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${parent},module`]);
    await gitAsAuthor(directory, ['commit', '-m', 'gitlink']);
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, []);
    expect(await readdir(root)).toEqual(['file']);
  });
  it('現在のインデックスと外部の属性ファイルの影響を受けない', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'nested/file'), '$Format:%H$');
    await commitAll(directory, 'initial');
    const rev = (await git.head())!;
    const attributes = join(await temporaryDirectory(), 'attributes');
    await writeFile(attributes, '* export-ignore export-subst\n');
    await runGit(directory, ['config', 'core.attributesFile', attributes]);
    await writeFile(join(directory, 'nested/.gitattributes'), '* export-ignore export-subst\n');
    await runGit(directory, ['add', '.']);
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, rev, []);
    expect(await readFile(join(root, 'nested/file'), 'utf8')).toBe('$Format:%H$');
  });

  it('起動時に展開先のない完了情報を掃除する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'data');
    await commitAll(directory, 'initial');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const root = await store.get(git, (await git.head())!, []);
    await rm(root, { recursive: true });
    await store.initialize();
    expect(await readdir(join(root, '..'))).toEqual([]);
  });
});

describe('revisionArchiveStore の境界', () => {
  it.each(['HEAD', 'ＨＥＡＤ.', 'HE\u200bAD'])(
    'config がなくても %s と objects・refs の中身を公開しない',
    async (head) => {
      const { directory, git } = await repository();
      await mkdir(join(directory, 'bare/objects'), { recursive: true });
      await mkdir(join(directory, 'bare/refs'));
      for (const path of [`bare/${head}`, 'bare/objects/x', 'bare/refs/x', 'safe']) {
        await writeFile(join(directory, path), 'data');
      }
      await commitAll(directory, 'bare');
      await mkdir(join(directory, 'bare/vendor'));
      const store = new RevisionArchiveStore(await temporaryDirectory());
      const root = await store.get(git, (await git.head())!, ['bare/vendor']);
      expect(await readdir(join(root, 'bare'))).toEqual([]);
      expect(await readFile(join(root, 'safe'), 'utf8')).toBe('data');
    },
  );
  it('直下の HEAD と commondir を除外し、部分的な構成は保つ', async () => {
    const { directory, git } = await repository();
    for (const path of ['HEAD', 'commondir']) {
      await writeFile(join(directory, path), 'data');
    }
    await commitAll(directory, 'root bare');
    const store = new RevisionArchiveStore(await temporaryDirectory());
    await mkdir(join(directory, 'node_modules'));
    expect(await readdir(await store.get(git, (await git.head())!, ['node_modules']))).toEqual([]);
    await rm(join(directory, 'commondir'));
    await mkdir(join(directory, 'objects'));
    await writeFile(join(directory, 'objects/x'), 'data');
    await commitAll(directory, 'partial');
    const root = await store.get(git, (await git.head())!, []);
    expect(await readFile(join(root, 'HEAD'), 'utf8')).toBe('data');
    expect(await readFile(join(root, 'objects/x'), 'utf8')).toBe('data');
  });
  it.each([
    ['A.ts', 'a.ts'],
    ['e\u0301.ts', 'é.ts'],
    ['a', 'A/b'],
    ['A/b', 'a/c'],
  ])('衝突 %j を両方除外し、通知を一度出して再利用する', async (...paths) => {
    const { directory, git } = await repository();
    for (const path of [...paths, 'safe']) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), 'data');
    }
    await commitAll(directory, 'collision');
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      () => Promise.resolve(true),
      Date.now,
      () => Promise.resolve(true),
    );
    const rev = (await git.head())!;
    const root = await store.get(git, rev, []);
    for (const path of paths) {
      await expect(lstat(join(root, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('data');
    expect(await store.get(git, rev, [])).toBe(root);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('linkPaths の親が履歴ファイルならリンクを省略する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'vendor'), 'historical file');
    await commitAll(directory, 'file');
    const rev = (await git.head())!;
    await rm(join(directory, 'vendor'));
    await mkdir(join(directory, 'vendor/modules'), { recursive: true });
    const root = await new RevisionArchiveStore(await temporaryDirectory()).get(git, rev, ['vendor/modules']);
    expect(await readFile(join(root, 'vendor'), 'utf8')).toBe('historical file');
  });
  it('再利用と保持対象の時刻を更新し、後の LRU で残す', async () => {
    archiveClock();
    const { directory, git } = await repository();
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const roots: string[] = [];
    const revisions: string[] = [];
    for (const text of ['one', 'two', 'three']) {
      await writeFile(join(directory, 'file'), text);
      await commitAll(directory, text);
      revisions.push((await git.head())!);
      roots.push(await store.get(git, revisions.at(-1)!, []));
    }
    expect(await store.prune(2, new Set(), () => true)).toEqual([]);
    for (const root of roots) {
      await expect(lstat(root)).resolves.toBeDefined();
    }
    await store.get(git, revisions[0]!, []);
    expect(await store.prune(2, new Set([roots[1]!]))).toEqual([roots[2]]);
    await expect(lstat(roots[0]!)).resolves.toBeDefined();
    await expect(lstat(roots[1]!)).resolves.toBeDefined();
    await expect(lstat(roots[2]!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.prune(2, new Set(), () => true)).toEqual([]);
    await writeFile(join(directory, 'file'), 'four');
    await commitAll(directory, 'four');
    await store.get(git, (await git.head())!, []);
    expect(await store.prune(2, new Set())).toEqual([roots[0]]);
    expect((await lstat(roots[1]!)).isDirectory()).toBe(true);
  });
  it('保存先が通常ファイルなら拒否し、直した後は再試行できる', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'data');
    await commitAll(directory, 'initial');
    const storage = await temporaryDirectory();
    await mkdir(join(storage, 'revisionArchives'));
    const parent = join(storage, 'revisionArchives', repositoryId(directory));
    await writeFile(parent, 'blocked');
    const store = new RevisionArchiveStore(storage);
    await expect(store.get(git, (await git.head())!, [])).rejects.toMatchObject({ code: 'EEXIST' });
    await rm(parent);
    expect(await readFile(join(await store.get(git, (await git.head())!, []), 'file'), 'utf8')).toBe('data');
  });
  it('壊れたリンクを飛ばし、使えるリンクと履歴ファイルは残す', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'safe'), 'data');
    await commitAll(directory, 'safe');
    await symlink('/missing-vsreview-target', join(directory, 'broken'));
    await symlink('/missing-vsreview-target-two', join(directory, 'broken-two'));
    await mkdir(join(directory, 'modules'));
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    const root = await store.get(git, (await git.head())!, ['broken', 'broken-two', 'modules']);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('data');
    expect(await store.links(root)).toEqual(['modules']);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('不正 UTF-8 と安全でないパスだけを飛ばして残りを展開する', async () => {
    const { directory, git } = await repository();
    for (const byte of [0xfe, 0xff]) {
      await writeFile(Buffer.concat([Buffer.from(directory + '/'), Buffer.from([byte])]), 'invalid');
    }
    await runGit(directory, ['config', 'core.protectNTFS', 'false']);
    await mkdir(join(directory, 'git~1'));
    await writeFile(join(directory, 'git~1/config'), 'unsafe');
    await writeFile(join(directory, 'safe'), 'valid');
    await commitAll(directory, 'paths');
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    const root = await store.get(git, (await git.head())!, []);
    expect(await readdir(root)).toEqual(['safe']);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('valid');
    expect(warning.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('安全でないパス'),
      expect.stringContaining('UTF-8'),
    ]);
  });
  it('保存数をリポジトリごとに数え、別リポジトリの展開を削除しない', async () => {
    const store = new RevisionArchiveStore(await temporaryDirectory());
    const roots: string[][] = [];
    for (let repo = 0; repo < 2; repo++) {
      const { directory, git } = await repository();
      const expanded: string[] = [];
      for (let rev = 0; rev < 2; rev++) {
        await writeFile(join(directory, 'file'), String(rev));
        await commitAll(directory, String(rev));
        expanded.push(await store.get(git, (await git.head())!, []));
      }
      roots.push(expanded);
    }
    expect(await store.prune(2, new Set())).toEqual([]);
    for (const root of roots.flat()) {
      expect((await lstat(root)).isDirectory()).toBe(true);
    }
  });
  it('展開先が通常ファイルなら有効と認めず、無関係な保存物は掃除しない', async () => {
    const storage = await temporaryDirectory();
    const store = new RevisionArchiveStore(storage);
    const file = join(storage, 'file');
    await writeFile(file, 'data');
    expect(await store.valid(file, '/repo')).toBe(false);
    await mkdir(join(storage, 'revisionArchives', 'unrelated'), { recursive: true });
    const other = join(storage, 'revisionArchives', 'unrelated', '.tmp-keep');
    await writeFile(other, 'keep');
    await store.initialize();
    expect(await readFile(other, 'utf8')).toBe('keep');
  });
  it('ファイルのリンク作成が EPERM でも履歴を展開して一度通知する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'safe'), 'history');
    await commitAll(directory, 'safe');
    await writeFile(join(directory, 'local'), 'local');
    vi.spyOn(fs, 'symlink').mockRejectedValue(Object.assign(new Error('not permitted'), { code: 'EPERM' }));
    syncBuiltinESMExports();
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    const root = await store.get(git, (await git.head())!, ['local']);
    expect(await readFile(join(root, 'safe'), 'utf8')).toBe('history');
    expect(await store.links(root)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('保存先がディレクトリへのリンクなら拒否する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'safe'), 'history');
    await commitAll(directory, 'safe');
    const storage = await temporaryDirectory();
    await symlink(await temporaryDirectory(), join(storage, 'revisionArchives'));
    await expect(new RevisionArchiveStore(storage).get(git, (await git.head())!, [])).rejects.toThrow(
      '保存先がディレクトリではありません',
    );
  });
  it('大小文字を区別しても正規化で同一視する保存先では NFC/NFD を双方除外する', async () => {
    const { directory, git } = await repository();
    for (const name of ['é.ts', 'e\u0301.ts', 'safe']) {
      await writeFile(join(directory, name), name);
    }
    await commitAll(directory, 'normalization');
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      () => Promise.resolve(false),
      Date.now,
      () => Promise.resolve(true),
    );
    const root = await store.get(git, (await git.head())!, []);
    expect(await readdir(root)).toEqual(['safe']);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('revisionArchiveStore のリンクパターン', () => {
  async function fixture() {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'packages/日本 語/src'), { recursive: true });
    await writeFile(join(directory, 'packages/日本 語/src/main.ts'), 'historical');
    await commitAll(directory, 'package');
    const rev = (await git.head())!;
    const warning = vi.fn<(message: string) => void>();
    const store = new RevisionArchiveStore(await temporaryDirectory(), warning);
    return { directory, git, rev, warning, store };
  }
  it('ignoreの有無によらず直下と履歴の親にリンクし、同じ候補はまとめる', async () => {
    const { directory, git, rev, store } = await fixture();
    await writeFile(join(directory, '.gitignore'), '/node_modules/\n');
    for (const path of ['node_modules', 'packages/日本 語/node_modules', 'new/node_modules']) {
      await mkdir(join(directory, path), { recursive: true });
      await writeFile(join(directory, path, 'value'), path);
    }
    const root = await store.get(git, rev, ['**/node_modules', 'packages/日本 語/node_modules', '**/node_modules']);
    expect((await store.links(root)).sort()).toEqual(['node_modules', 'packages/日本 語/node_modules']);
    expect(await readFile(join(root, 'packages/日本 語/node_modules/value'), 'utf8')).toBe(
      'packages/日本 語/node_modules',
    );
    await expect(lstat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new RevisionArchiveStore(await temporaryDirectory()).links(root)).toEqual(await store.links(root));
    expect(await store.get(git, rev, [])).toBe(root);
    expect(await store.links(root)).toHaveLength(2);
  });
  it('現在追跡中のディレクトリは古い履歴に存在しなくてもリンクしない', async () => {
    const { directory, git, rev, store, warning } = await fixture();
    await mkdir(join(directory, 'packages/日本 語/node_modules'));
    await writeFile(join(directory, 'packages/日本 語/node_modules/tracked'), 'tracked');
    await runGit(directory, ['add', '.']);
    const root = await store.get(git, rev, ['**/node_modules']);
    expect(await store.links(root)).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
    await expect(lstat(join(root, 'packages/日本 語/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('不正UTF-8の追跡ファイルがあっても展開し、その親はリンクしない', async () => {
    const { directory, git, rev, store } = await fixture();
    await mkdir(join(directory, 'node_modules'));
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
    // 実 FS では作れない OS もあるため、不正 UTF-8 名はインデックスにだけ登録する。
    const record = Buffer.concat([Buffer.from(`100644 ${hash}\tnode_modules/`), Buffer.from([0xff, 0])]);
    await runGit(directory, ['update-index', '-z', '--index-info'], record);

    await mkdir(join(directory, 'packages/日本 語/node_modules'));
    const root = await store.get(git, rev, ['**/node_modules']);
    expect(await store.links(root)).toEqual(['packages/日本 語/node_modules']);
    expect(await readFile(join(root, 'packages/日本 語/src/main.ts'), 'utf8')).toBe('historical');
  });
  it('候補がファイルなら省略し、固定パスは親を作る', async () => {
    const { directory, git, rev, store, warning } = await fixture();
    await writeFile(join(directory, 'node_modules'), 'file');
    await mkdir(join(directory, 'vendor/deps'), { recursive: true });
    await mkdir(join(directory, 'packages/日本 語/src/deps'));
    await rm(join(directory, 'packages/日本 語/src/main.ts'));
    const root = await store.get(git, rev, ['**/node_modules', '**/deps', 'vendor/deps']);
    expect((await store.links(root)).sort()).toEqual(['packages/日本 語/src/deps', 'vendor/deps']);
    expect(warning).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'packages/日本 語/src/main.ts'), 'utf8')).toBe('historical');
  });
  it('履歴の同名ディレクトリと候補の内側を上書きしない', async () => {
    const { directory, git, store } = await fixture();
    await mkdir(join(directory, 'node_modules/.pnpm/pkg/node_modules'), { recursive: true });
    await writeFile(join(directory, 'node_modules/.pnpm/pkg/source'), 'history');
    await commitAll(directory, 'tracked modules');
    const rev = (await git.head())!;
    await runGit(directory, ['rm', '-r', '--cached', 'node_modules']);
    const root = await store.get(git, rev, ['**/node_modules']);
    expect(await store.links(root)).toEqual([]);
    expect(await readFile(join(root, 'node_modules/.pnpm/pkg/source'), 'utf8')).toBe('history');
  });
  it('外部リンクと壊れた候補を飛ばし、安全な兄弟と履歴を残す', async () => {
    const { directory, git, rev, store, warning } = await fixture();
    await symlink(await temporaryDirectory(), join(directory, 'node_modules'), 'junction');
    await symlink(join(directory, 'missing'), join(directory, 'packages/node_modules'), 'junction');
    await mkdir(join(directory, 'packages/日本 語/node_modules'));
    const root = await store.get(git, rev, ['**/node_modules']);
    expect(await store.links(root)).toEqual(['packages/日本 語/node_modules']);
    expect(warning.mock.calls.map(([message]) => message).sort()).toEqual([
      'リポジトリ外を指すリンクを除いてリビジョンを展開しました',
      '利用できないリンクを除外してリビジョンを展開しました',
    ]);
  });
  it.each([
    ['Node_Modules', 'node_modules', true, false],
    ['café', 'cafe\u0301', false, true],
  ])(
    'FSの別名で追跡しているディレクトリをリンクしない: %s',
    async (tracked, candidate, ignoreCase, ignoreNormalization) => {
      const { directory, git, rev, warning } = await fixture();
      await mkdir(join(directory, candidate));
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(directory, ['update-index', '-z', '--index-info'], `100644 ${hash}\t${tracked}/file\0`);
      const store = new RevisionArchiveStore(
        await temporaryDirectory(),
        warning,
        () => Promise.resolve(ignoreCase),
        Date.now,
        () => Promise.resolve(ignoreNormalization),
      );
      const root = await store.get(git, rev, [`**/${candidate}`]);
      expect(await store.links(root)).toEqual([]);
      expect(warning).not.toHaveBeenCalled();
    },
  );
  it('固定パスだけでも作業ツリーのディレクトリへリンクする', async () => {
    const { directory, git, rev, store } = await fixture();
    await mkdir(join(directory, 'deps'));
    const root = await store.get(git, rev, ['deps']);
    expect(await store.links(root)).toEqual(['deps']);
    expect(await lstat(join(root, 'deps')).then((entry) => entry.isSymbolicLink())).toBe(true);
  });
  it.each([
    [false, []],
    [true, ['パターンと区別できないリンクを除いてリビジョンを展開しました']],
  ])('直下の ** の候補が存在するときだけ通知し、完成した展開を再利用する: %s', async (present, messages) => {
    const { directory, git, warning } = await fixture();
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'history')).toString().trim();
    const subtree = (await runGit(directory, ['mktree', '-z'], `100644 blob ${hash}\tfile\0`)).toString().trim();
    const rev = (await runGit(directory, ['mktree', '-z'], `040000 tree ${subtree}\t**\0`)).toString().trim();
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      undefined,
      undefined,
      undefined,
      'linux',
      (path) => Promise.resolve(path === join(directory, '**/deps') && present),
    );
    const root = await store.get(git, rev, ['**/deps']);
    expect(await store.links(root)).toEqual([]);
    expect(await store.valid(root, directory)).toBe(true);
    expect(await store.get(git, rev, ['**/deps'])).toBe(root);
    expect(warning.mock.calls.map(([message]) => message)).toEqual(messages);
  });
  it('不正なWindows候補名は展開失敗として返す', async () => {
    const { git, rev, warning } = await fixture();
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      undefined,
      undefined,
      undefined,
      'win32',
    );
    await expect(store.get(git, rev, ['**/CON'])).rejects.toThrow('展開先のパスが不正');
  });
  it('多数の候補を並列数の上限内で調べ、安全なリンクをすべて残す', async () => {
    const { directory, git, warning } = await fixture();
    for (let i = 0; i < LINK_PATH_CONCURRENCY * 2 + 1; i++) {
      await mkdir(join(directory, `pkg${i}/deps`), { recursive: true });
      await writeFile(join(directory, `pkg${i}/file`), 'history');
    }
    await commitAll(directory, 'many packages');
    let active = 0;
    let peak = 0;
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      undefined,
      undefined,
      undefined,
      undefined,
      async (path) => {
        peak = Math.max(peak, ++active);
        try {
          return await lstat(path).then(
            () => true,
            () => false,
          );
        } finally {
          active--;
        }
      },
    );
    const root = await store.get(git, (await git.head())!, ['**/deps']);
    expect(await store.links(root)).toHaveLength(LINK_PATH_CONCURRENCY * 2 + 1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LINK_PATH_CONCURRENCY);
    expect(active).toBe(0);
  });
  it('候補の検査失敗後は残りを始めず、再要求で復旧する', async () => {
    const { directory, git, rev, warning } = await fixture();
    const names = Array.from({ length: LINK_PATH_CONCURRENCY * 2 }, (_, i) => `**/deps${i}`);
    let started = 0;
    const sourceIsDirectory = vi.fn((): Promise<boolean> => {
      started++;
      return Promise.reject(new Error('source check failed'));
    });
    const store = new RevisionArchiveStore(
      await temporaryDirectory(),
      warning,
      undefined,
      undefined,
      undefined,
      undefined,
      sourceIsDirectory,
    );
    await expect(store.get(git, rev, names)).rejects.toThrow('source check failed');
    expect(started).toBeLessThanOrEqual(LINK_PATH_CONCURRENCY);
    expect(started).toBeGreaterThan(0);
    sourceIsDirectory.mockResolvedValue(false);
    const root = await store.get(git, rev, names);
    expect(await store.valid(root, directory)).toBe(true);
    expect(await store.links(root)).toEqual([]);
  });
  it('Gitの候補探索失敗は展開失敗として返し、再要求で復旧する', async () => {
    const { git, rev, store } = await fixture();
    vi.spyOn(git, 'trackedPaths').mockRejectedValueOnce(new Error('git ls-files failed'));
    await expect(store.get(git, rev, ['**/node_modules'])).rejects.toThrow('git ls-files failed');
    const root = await store.get(git, rev, ['**/node_modules']);
    expect(await readFile(join(root, 'packages/日本 語/src/main.ts'), 'utf8')).toBe('historical');
  });
  it('履歴の親が欠けたblobで展開されなければパターンのために作成しない', async () => {
    const { directory, git, store, warning } = await fixture();
    const hash = 'f'.repeat(40);
    const tree = (await runGit(directory, ['mktree', '--missing', '-z'], `100644 blob ${hash}\tfile\0`))
      .toString()
      .trim();
    const rootTree = (await runGit(directory, ['mktree', '-z'], `040000 tree ${tree}\tmissing-parent\0`))
      .toString()
      .trim();
    await mkdir(join(directory, 'missing-parent/node_modules'), { recursive: true });
    const root = await store.get(git, rootTree, ['**/node_modules']);
    expect(await store.links(root)).toEqual([]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('欠けた blob'));
    await expect(lstat(join(root, 'missing-parent'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('固定の子パスが無ければパターンの親をリンクする', async () => {
    const { directory, git, rev, store } = await fixture();
    await mkdir(join(directory, 'node_modules'));
    await writeFile(join(directory, 'node_modules/other'), 'dependency');
    const root = await store.get(git, rev, ['**/node_modules', 'node_modules/missing']);
    expect(await store.links(root)).toEqual(['node_modules']);
    expect(await readFile(join(root, 'node_modules/other'), 'utf8')).toBe('dependency');
  });
  it.each([
    ['**/deps', 'packages/日本 語/deps/file'],
    ['packages/日本 語/deps/file', '**/deps'],
  ])('固定の子パスを優先してパターンの親を重ねない: %j', async (...links) => {
    const { directory, git, rev, store } = await fixture();
    await mkdir(join(directory, 'packages/日本 語/deps'), { recursive: true });
    await writeFile(join(directory, 'packages/日本 語/deps/file'), 'fixed');
    const root = await store.get(git, rev, links);
    expect(await store.links(root)).toEqual(['packages/日本 語/deps/file']);
    expect(await readFile(join(root, 'packages/日本 語/deps/file'), 'utf8')).toBe('fixed');
  });
});
