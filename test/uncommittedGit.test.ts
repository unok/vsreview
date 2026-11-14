import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute } from 'node:path';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { GitClient, GitError, runGit } from '../src/git/client';
import { createUncommittedChanges } from '../src/git/uncommitted';
import { isUncommittedChanged, type UncommittedChanges, type UncommittedKind } from '../src/core/uncommitted';
import { deserialize, serialize } from '../src/core/model';
import { isRecord } from '../src/core/validation';
import { repository, temporaryDirectory, gitProcesses, reviewComment } from './fixtures';
import { commitAll, gitAsAuthor } from './gitFixtures';

const CREATED_AT = '2026-11-14T00:00:00Z';
const ORIGINAL = 'one\ntwo\nthree\nfour\nfive\n';
beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
async function base() {
  const fixture = await repository();
  await mkdir(join(fixture.directory, 'src'));
  await writeFile(join(fixture.directory, 'src/a.ts'), ORIGINAL);
  await writeFile(join(fixture.directory, 'src/b.ts'), 'second file\n');
  await writeFile(join(fixture.directory, '.gitignore'), 'dist/\n');
  await commitAll(fixture.directory, 'base');
  return fixture;
}
async function state(git: GitClient) {
  const { gitDir } = await git.directories();
  const entries = await readdir(git.root, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && relative(git.root, join(entry.parentPath, entry.name)).split(/[\\/]/)[0] !== '.git',
      )
      .map(async (entry) => [
        relative(git.root, join(entry.parentPath, entry.name)),
        await readFile(join(entry.parentPath, entry.name)),
      ]),
  );
  const index = await readFile(join(gitDir, 'index')).catch((error: unknown) => {
    if (isRecord(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  return {
    index,
    files,
    status: await runGit(git.root, ['--no-optional-locks', 'status', '--porcelain']),
    refs: await runGit(git.root, ['for-each-ref']),
  };
}
async function snapshot(git: GitClient) {
  const before = await state(git);
  const processes = gitProcesses();
  const start = processes.mock.calls.length;
  try {
    return await createUncommittedChanges(git, CREATED_AT);
  } finally {
    expect(await state(git)).toEqual(before);
    const indexes = processes.mock.calls.slice(start).flatMap((call) => {
      const options: unknown = call[2];
      if (!isRecord(options) || !isRecord(options.env)) {
        return [];
      }
      const index = options.env.GIT_INDEX_FILE;
      return typeof index === 'string' ? [index] : [];
    });
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of new Set(indexes)) {
      const inside = relative(tmpdir(), index);
      expect(isAbsolute(inside) || inside.split(/[\\/]/).includes('..')).toBe(false);
      await expect(readdir(dirname(index))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }
}
function saved(changes: UncommittedChanges, kind: UncommittedKind) {
  return {
    ...reviewComment,
    commit: changes[kind].commit.hash,
    parent: changes[kind].parent,
    uncommitted: { kind, createdAt: changes.createdAt, ...(changes.head ? { head: changes.head } : {}) },
  };
}

describe('未コミットのスナップショット', () => {
  it('HEAD と index がなくても空の一覧と空 tree を返す', async () => {
    const { git } = await repository();
    const changes = await snapshot(git);
    expect(changes.head).toBeUndefined();
    expect(changes.staged.files).toEqual([]);
    expect(changes.unstaged.files).toEqual([]);
    expect(await git.tree(changes.staged.parent)).toEqual([]);
  });
  it('初回コミット前のステージ済みと未追跡を分離する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'staged');
    await runGit(directory, ['add', 'a']);
    await writeFile(join(directory, 'b'), 'untracked');
    const changes = await snapshot(git);
    expect(changes.staged.files).toEqual([{ path: 'a', status: 'A' }]);
    expect(changes.unstaged.files).toEqual([{ path: 'b', status: 'A' }]);
    expect(await git.tree(changes.staged.parent)).toEqual([]);
  });
  it('変更なしでは両方空で、作成日時だけ変えても同じ SHA になる', async () => {
    const { git } = await base();
    const head = await git.head();
    const first = await snapshot(git);
    expect(first.head).toBe(head);
    expect(first.staged.kind).toBe('staged');
    expect(first.unstaged.kind).toBe('unstaged');
    expect(first.staged.parent).toBe(head);
    const second = await createUncommittedChanges(git, '2026-11-15T00:00:00Z');
    expect(first.createdAt).toBe(CREATED_AT);
    expect(second.createdAt).toBe('2026-11-15T00:00:00Z');
    for (const kind of ['staged', 'unstaged'] as const) {
      expect(first[kind].files).toEqual([]);
      expect(second[kind].commit.hash).toBe(first[kind].commit.hash);
      expect(isUncommittedChanged(saved(first, kind), second)).toBe(false);
    }
  });
  it('ステージ済みのみの変更を返す', async () => {
    const { directory, git } = await base();
    await writeFile(join(directory, 'src/a.ts'), 'staged\n');
    await runGit(directory, ['add', 'src/a.ts']);
    const changes = await snapshot(git);
    expect(changes.staged.files).toEqual([{ path: 'src/a.ts', status: 'M' }]);
    expect(changes.unstaged.files).toEqual([]);
  });
  it('未ステージと未追跡を含め、無視された未追跡だけ除外する', async () => {
    const { directory, git } = await base();
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist/kept.js'), 'tracked');
    await runGit(directory, ['add', '-f', 'dist/kept.js']);
    await gitAsAuthor(directory, ['commit', '-m', 'tracked ignored file']);
    await writeFile(join(directory, 'dist/kept.js'), 'changed');
    await writeFile(join(directory, 'dist/out.js'), 'ignored');
    await writeFile(join(directory, 'src/b.ts'), 'modified');
    await writeFile(join(directory, 'src/c.ts'), 'unique untracked');
    const changes = await snapshot(git);
    expect(changes.staged.files).toEqual([]);
    expect(changes.unstaged.files).toEqual([
      { path: 'dist/kept.js', status: 'M' },
      { path: 'src/b.ts', status: 'M' },
      { path: 'src/c.ts', status: 'A' },
    ]);
  });
  it('同じファイルの staged と unstaged の内容と patch を分離する', async () => {
    const { directory, git } = await base();
    const indexed = ORIGINAL.replace('one', 'ONE');
    const working = indexed.replace('five', 'FIVE');
    await writeFile(join(directory, 'src/a.ts'), indexed);
    await runGit(directory, ['add', 'src/a.ts']);
    await writeFile(join(directory, 'src/a.ts'), working);
    const changes = await snapshot(git);
    for (const [kind, old, next, added, excluded] of [
      ['staged', ORIGINAL, indexed, '+ONE', '+FIVE'],
      ['unstaged', indexed, working, '+FIVE', '+ONE'],
    ] as const) {
      const change = changes[kind];
      expect(change.files).toEqual([{ path: 'src/a.ts', status: 'M' }]);
      expect(await git.blob(change.parent, 'src/a.ts')).toEqual(Buffer.from(old));
      expect(await git.blob(change.commit.hash, 'src/a.ts')).toEqual(Buffer.from(next));
      const patch = await git.patch(change.parent, change.commit.hash, change.files[0]!);
      expect(patch).toContain(added);
      expect(patch).not.toContain(excluded);
    }
  });
  it('index と同時刻・同サイズの変更を stat キャッシュで見落とさない', async () => {
    const { directory, git } = await base();
    const path = join(directory, 'src/b.ts');
    const time = new Date('2001-01-01T00:00:00Z');
    await runGit(directory, ['config', 'core.trustctime', 'false']);
    await writeFile(path, 'before\n');
    await utimes(path, time, time);
    await commitAll(directory, 'cached stat');
    const { gitDir } = await git.directories();
    await utimes(join(gitDir, 'index'), time, time);
    await writeFile(path, 'AFTER!\n');
    await utimes(path, time, time);
    const changes = await snapshot(git);
    expect(changes.unstaged.files).toEqual([{ path: 'src/b.ts', status: 'M' }]);
    expect(await git.blob(changes.unstaged.commit.hash, 'src/b.ts')).toEqual(Buffer.from('AFTER!\n'));
  });
  for (const kind of ['staged', 'unstaged'] as const) {
    for (const operation of ['delete', 'rename'] as const) {
      it(`${kind} の ${operation} を D/R として返す`, async () => {
        const { directory, git } = await base();
        if (operation === 'delete') {
          await rm(join(directory, 'src/b.ts'));
        } else {
          await rename(join(directory, 'src/b.ts'), join(directory, 'src/y.ts'));
        }
        if (kind === 'staged') {
          await runGit(directory, ['add', '-A']);
        }
        const changes = await snapshot(git);
        expect(changes[kind].files).toEqual(
          operation === 'delete'
            ? [{ path: 'src/b.ts', status: 'D' }]
            : [{ path: 'src/y.ts', oldPath: 'src/b.ts', status: 'R' }],
        );
        expect(changes[kind === 'staged' ? 'unstaged' : 'staged'].files).toEqual([]);
      });
    }
  }
  it('追跡済みファイルと同内容の未追跡ファイルを C として返す', async () => {
    const { directory, git } = await base();
    await writeFile(join(directory, 'src/copy.ts'), ORIGINAL);
    expect((await snapshot(git)).unstaged.files).toEqual([{ path: 'src/copy.ts', oldPath: 'src/a.ts', status: 'C' }]);
  });
  it('空・バイナリ・空白・非 ASCII・先頭ハイフンのファイルを固定する', async () => {
    const { directory, git } = await base();
    const contents = new Map([
      ['empty', Buffer.alloc(0)],
      ['binary', Buffer.from([0, 255, 1])],
      ['日本 語.ts', Buffer.from('日本語')],
      ['-name.ts', Buffer.from('literal path')],
    ]);
    for (const [path, content] of contents) {
      await writeFile(join(directory, path), content);
    }
    const added = await snapshot(git);
    for (const [path, content] of contents) {
      expect(added.unstaged.files).toContainEqual({ path, status: 'A' });
      expect(await git.blob(added.unstaged.commit.hash, path)).toEqual(content);
    }
    await runGit(directory, ['add', '-A']);
    await gitAsAuthor(directory, ['commit', '-m', 'boundaries']);
    for (const [path, content] of contents) {
      await writeFile(join(directory, path), Buffer.concat([content, Buffer.from('changed')]));
    }
    const modified = await snapshot(git);
    for (const [path, content] of contents) {
      expect(modified.unstaged.files).toContainEqual({ path, status: 'M' });
      expect(await git.blob(modified.unstaged.parent, path)).toEqual(content);
      expect(await git.blob(modified.unstaged.commit.hash, path)).toEqual(
        Buffer.concat([content, Buffer.from('changed')]),
      );
    }
  });
  it('作業ツリーの変更後も旧内容を保ち、戻すと未変更になる', async () => {
    const { directory, git } = await base();
    const first = await snapshot(git);
    await writeFile(join(directory, 'src/b.ts'), 'new working content');
    const current = await snapshot(git);
    expect(isUncommittedChanged(saved(first, 'staged'), current)).toBe(false);
    expect(isUncommittedChanged(saved(first, 'unstaged'), current)).toBe(true);
    expect(await git.blob(first.unstaged.commit.hash, 'src/b.ts')).toEqual(Buffer.from('second file\n'));
    await writeFile(join(directory, 'src/b.ts'), 'second file\n');
    expect(isUncommittedChanged(saved(first, 'unstaged'), await snapshot(git))).toBe(false);
  });
  it('add では両方が変わり、コミット・HEAD のみの移動では staged だけ変わる', async () => {
    const { directory, git } = await base();
    await writeFile(join(directory, 'src/b.ts'), 'change');
    const working = await snapshot(git);
    await runGit(directory, ['add', '-A']);
    const indexed = await snapshot(git);
    for (const kind of ['staged', 'unstaged'] as const) {
      expect(isUncommittedChanged(saved(working, kind), indexed)).toBe(true);
    }
    await gitAsAuthor(directory, ['commit', '-m', 'commit staged']);
    const committed = await snapshot(git);
    expect(isUncommittedChanged(saved(indexed, 'staged'), committed)).toBe(true);
    expect(isUncommittedChanged(saved(indexed, 'unstaged'), committed)).toBe(false);
    await gitAsAuthor(directory, ['commit', '--allow-empty', '-m', 'head only']);
    const emptyCommit = await snapshot(git);
    expect(isUncommittedChanged(saved(committed, 'staged'), emptyCommit)).toBe(true);
    expect(isUncommittedChanged(saved(committed, 'unstaged'), emptyCommit)).toBe(false);
  });
  it('消失したオブジェクトを再生成し、判定と保存済みのコード・本文を失わない', async () => {
    const { directory, git } = await base();
    await writeFile(join(directory, 'src/b.ts'), 'snapshot content');
    const first = await snapshot(git);
    const comment = saved(first, 'unstaged');
    const persisted: unknown = JSON.parse(JSON.stringify(serialize([comment])));
    const hash = comment.commit;
    const { commonDir } = await git.directories();
    const object = join(commonDir, 'objects', hash.slice(0, 2), hash.slice(2));
    await rm(object);
    expect(await git.hasCommit(hash)).toBe(false);
    expect(isUncommittedChanged(comment, await snapshot(git))).toBe(false);
    expect(await git.hasCommit(hash)).toBe(true);
    await rm(object);
    await writeFile(join(directory, 'src/b.ts'), 'changed again');
    expect(isUncommittedChanged(comment, await snapshot(git))).toBe(true);
    expect(deserialize(persisted)).toEqual([comment]);
  });
  it('競合で失敗しても一時 index を消し、競合解消後に再実行できる', async () => {
    const { directory, git } = await base();
    await runGit(directory, ['checkout', '-b', 'other']);
    await writeFile(join(directory, 'src/a.ts'), 'other\n');
    await commitAll(directory, 'other');
    await runGit(directory, ['checkout', 'main']);
    await writeFile(join(directory, 'src/a.ts'), 'main\n');
    await commitAll(directory, 'main');
    await expect(gitAsAuthor(directory, ['merge', 'other'])).rejects.toThrow();
    await expect(snapshot(git)).rejects.toBeInstanceOf(GitError);
    await writeFile(join(directory, 'src/a.ts'), 'resolved\n');
    await runGit(directory, ['add', 'src/a.ts']);
    expect((await snapshot(git)).staged.files).toEqual([{ path: 'src/a.ts', status: 'M' }]);
  });
  it('index のコピーが ENOENT 以外で失敗したら元のエラーを伝え、一時領域を消す', async () => {
    const { git } = await base();
    const { gitDir } = await git.directories();
    const index = join(gitDir, 'index');
    await rm(index);
    await mkdir(index);
    const temporaryRoot = await temporaryDirectory();
    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(temporaryRoot);
    syncBuiltinESMExports();

    await expect(createUncommittedChanges(git, CREATED_AT)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(tmpdirSpy).toHaveBeenCalled();
    expect(await readdir(temporaryRoot)).toEqual([]);
  });
  it('作者未設定・署名設定ありでも固定作者で生成する', async () => {
    const { git, directory } = await repository();
    await runGit(directory, ['config', 'user.useConfigOnly', 'true']);
    await runGit(directory, ['config', 'commit.gpgSign', 'true']);
    const changes = await snapshot(git);
    expect(await git.hasCommit(changes.staged.commit.hash)).toBe(true);
    expect(await git.hasCommit(changes.unstaged.commit.hash)).toBe(true);
  });
  it('linked worktree 固有の index を使い、元リポジトリも変えない', async () => {
    const { directory, git } = await base();
    const worktree = join(await temporaryDirectory(), 'linked');
    await runGit(directory, ['worktree', 'add', '-b', 'linked', worktree]);
    const linked = await GitClient.resolve(worktree);
    await writeFile(join(worktree, 'src/a.ts'), 'linked staged');
    await runGit(worktree, ['add', 'src/a.ts']);
    const before = await state(git);
    const changes = await snapshot(linked);
    expect(changes.staged.files).toEqual([{ path: 'src/a.ts', status: 'M' }]);
    expect(await state(git)).toEqual(before);
  });
  it('split-index でも同じ一覧を返し、元 index を変更しない', async () => {
    const { directory, git } = await base();
    await writeFile(join(directory, 'src/a.ts'), 'staged');
    await runGit(directory, ['add', 'src/a.ts']);
    await writeFile(join(directory, 'src/b.ts'), 'working');
    const first = await snapshot(git);
    await runGit(directory, ['update-index', '--split-index']);
    const split = await snapshot(git);
    for (const kind of ['staged', 'unstaged'] as const) {
      expect(split[kind].files).toEqual(first[kind].files);
      expect(isUncommittedChanged(saved(first, kind), split)).toBe(false);
    }
  });
});
