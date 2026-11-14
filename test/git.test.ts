import * as executable from '../src/git/executable.mts';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { parseTreeRecord, type TreeRecord } from '../src/core/gitParsing';
import { GitStreamReader, copyBlob } from '../src/git/blobStream';
import { resolveGitExecutable } from '../src/git/executable.mts';
import { commandEnvironment } from '../src/git/environment';
import {
  GitClient,
  GitError,
  runGit,
  runGitStream,
  GIT_FETCH_TIMEOUT_MS,
  splitPathspecs,
  PATHSPEC_BATCH_MAX_BYTES,
} from '../src/git/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, writeFile, mkdir, rm, rename, unlink, chmod } from 'node:fs/promises';
import { join, delimiter, isAbsolute, basename } from 'node:path';
import { pullRequestRepository, repository, temporaryDirectory, gitProcesses } from './fixtures';
import { commitAll, gitAsAuthor } from './gitFixtures';

describe('git', () => {
  it.each([128, 129])(
    '直下の無視候補の引数が12KiBを超えたら検索範囲を省き、追跡照会は一度にする: %s',
    async (count) => {
      const { directory, git } = await repository();
      await writeFile(join(directory, '.gitignore'), '*.log\n');
      const candidates = Array.from({ length: count }, (_, i) => `${String(i).padStart(3, '0')}${'é'.repeat(44)}.log`);
      await writeFile(join(directory, candidates[0]!), 'tracked');
      await runGit(directory, ['add', '-f', candidates[0]!]);
      const processes = gitProcesses();
      expect(await git.ignoredPaths(candidates)).toEqual(new Set(candidates.slice(1)));
      const calls = processes.mock.calls.filter(([, args]) => args?.includes('ls-files'));
      expect(calls).toHaveLength(1);
      const args = calls[0]![1]!;
      expect(args.slice(args.indexOf('--exclude-standard') + 1)).toEqual(count === 128 ? ['--', ...candidates] : []);
    },
  );
  it('無視候補の先頭要素だけを重複なく追跡照会し、特殊文字もそのまま扱う', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, '.gitignore'), 'dist/\nnode_modules/\n*.log\n-out/\n日本 語/\n');
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist/keep'), 'tracked');
    await runGit(directory, ['add', '-f', 'dist/keep']);
    const candidates = ['dist/a', 'dist/b', 'node_modules/x', '*.log', '-out/x', '日本 語/x'];
    const processes = gitProcesses();
    expect(await git.ignoredPaths([...candidates, 'dist/keep'])).toEqual(new Set(candidates));
    const calls = processes.mock.calls.filter(([, args]) => args?.includes('ls-files'));
    expect(calls).toHaveLength(1);
    const args = calls[0]![1]!;
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['dist', 'node_modules', '*.log', '-out', '日本 語']);
  });
  it.each([
    ['build', 'build', 'build/keep'],
    ['dist/', 'dist/out.js', 'dist/out.js'],
  ])('追跡済みの親と無視ディレクトリ配下を除外しない: %s', async (rule, candidate, file) => {
    const { directory, git } = await repository();
    await writeFile(join(directory, '.gitignore'), `${rule}\n`);
    await mkdir(join(directory, file.split('/')[0]!));
    await writeFile(join(directory, file), 'tracked');
    await runGit(directory, ['add', '-f', file]);
    expect(await git.ignoredPaths([candidate])).toEqual(new Set());
  });
  it('大量の無視候補も追跡照会は一度だけで、追跡照会の失敗を伝える', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, '.gitignore'), 'dist/\n');
    const candidates = Array.from({ length: 1000 }, (_, i) => `dist/${'x'.repeat(40)}${i}`);
    const processes = gitProcesses();
    expect(await git.ignoredPaths(candidates)).toEqual(new Set(candidates));
    expect(processes.mock.calls.filter(([, args]) => args?.includes('ls-files'))).toHaveLength(1);
    const command = join(await temporaryDirectory(), 'failed-tracking');
    await writeFile(
      command,
      '#!/bin/sh\ncase " $* " in *" check-ignore "*) printf "dist/x\\0";; *) echo "tracking failed" >&2; exit 1;; esac\n',
    );
    await chmod(command, 0o755);
    vi.spyOn(executable, 'gitExecutable').mockReturnValue(command);
    await expect(git.ignoredPaths(['dist/x'])).rejects.toMatchObject({
      exitCode: 1,
    });
  });
  it('無視判定は空入力・追跡済み・特殊な名前を扱い、indexを変更しない', async () => {
    const { directory, git } = await repository();
    expect(await new GitClient('/not/a/repository').ignoredPaths([])).toEqual(new Set());
    expect(await git.ignoredPaths(['absent'])).toEqual(new Set());
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n*.log\n');
    await writeFile(join(directory, 't.log'), 'tracked');
    await runGit(directory, ['add', '-f', 't.log']);
    const { gitDir } = await git.directories();
    const index = await readFile(join(gitDir, 'index'));
    const special = ['日本 語.log', 'line\nbreak.log', '-option.log', '*.log'];
    expect(await git.ignoredPaths(['node_modules/x.js', 't.log', 'a.ts', ...special])).toEqual(
      new Set(['node_modules/x.js', ...special]),
    );
    expect(await readFile(join(gitDir, 'index'))).toEqual(index);
    await expect(new GitClient(await temporaryDirectory()).ignoredPaths(['a'])).rejects.toBeInstanceOf(GitError);
  });
  it('無視規則のないサブモジュール内のパスは除外しない', async () => {
    const { directory, git } = await repository();
    const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'submodule')).toString().trim();
    await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${hash},sub`]);
    expect(await git.ignoredPaths(['sub/file'])).toEqual(new Set());
  });
  describe('Git の基本操作', () => {
    let directory: string;
    let git: GitClient;
    beforeEach(async () => {
      const fixture = await repository();
      directory = fixture.directory;
      git = fixture.git;
    });
    it('候補の追跡有無だけをNUL区切りで読み、深い親・改行・空入力を扱う', async () => {
      expect(await git.trackedPaths(['absent'])).toEqual(new Set());
      expect(await new GitClient('/not/a/repository').trackedPaths([])).toEqual(new Set());
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(directory, ['update-index', '-z', '--index-info'], `100644 ${hash}\t日本 語/a/b/c\nfile\0`);
      expect(await git.trackedPaths(['日本 語/a', '日本 語/a/b', 'untracked'])).toEqual(
        new Set(['日本 語/a', '日本 語/a/b']),
      );
      await expect(new GitClient(await temporaryDirectory()).trackedPaths(['a'])).rejects.toBeInstanceOf(GitError);
    });
    it('pathspecをバイト上限で分割し、ちょうど上限・単独超過・空入力を扱う', () => {
      const full = 'a'.repeat(PATHSPEC_BATCH_MAX_BYTES - 1);
      expect(splitPathspecs([])).toEqual([]);
      expect(splitPathspecs([full])).toEqual([[full]]);
      expect(splitPathspecs([full, 'é'])).toEqual([[full], ['é']]);
      expect(() => splitPathspecs([full + 'a'])).toThrow('pathspec');
      expect(() => splitPathspecs(['é'.repeat(PATHSPEC_BATCH_MAX_BYTES / 2)])).toThrow('pathspec');
    });
    it('多数の候補を分割しても全バッチの追跡結果を返す', async () => {
      const candidates = Array.from({ length: 1500 }, (_, i) => `packages/long-package-name-${i}/deps`);
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(
        directory,
        ['update-index', '-z', '--index-info'],
        candidates.map((path) => `100644 ${hash}\t${path}/file\0`).join(''),
      );
      expect(await git.trackedPaths(candidates)).toEqual(new Set(candidates));
    });
    it('広げたglobの別キーを除外し、特殊文字を文字として比較する', async () => {
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(
        directory,
        ['update-index', '-z', '--index-info'],
        ['pkg[1]*?/file', 'other/file', 'x;name/file'].map((path) => `100644 ${hash}\t${path}\0`).join(''),
      );
      expect(await git.trackedPaths(['pkg[1]*?', 'absent', 'é'], false, true)).toEqual(new Set(['pkg[1]*?']));
      expect(await git.trackedPaths(['x;name'], false, true)).toEqual(new Set(['x;name']));
    });
    it.each([
      [';', '*'],
      ['`', '*'],
      ['K', '*'],
      ['node_modules', 'node_modules'],
    ])('正規化でASCII全体になる文字だけpathspecを広げる: %s', async (candidate, pattern) => {
      // 追跡結果だけでは検索範囲の広がりを検出できないため、実Gitへ渡すpathspecも確認する。
      const processes = vi.spyOn(childProcess, 'spawn');
      syncBuiltinESMExports();
      expect(await git.trackedPaths([candidate], false, true)).toEqual(new Set());
      const args = processes.mock.calls[0]![1];
      expect(args.slice(args.indexOf('--') + 1)).toEqual([`:(top,glob)${pattern}`, `:(top,glob)${pattern}/**`]);
    });
    it('ちょうど1MiBのGitレコードを受け入れる', async () => {
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      const path = `candidate/${'a'.repeat(1024 * 1024 - 'candidate/'.length)}`;
      await runGit(directory, ['update-index', '-z', '--index-info'], `100644 ${hash}\t${path}\0`);
      expect(await git.trackedPaths(['candidate'])).toEqual(new Set(['candidate']));
    });
    it('候補配下でも上限を超えるGitレコードは拒否する', async () => {
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(
        directory,
        ['update-index', '-z', '--index-info'],
        `100644 ${hash}\tcandidate/${'a'.repeat(1024 * 1024)}\0`,
      );
      await expect(git.trackedPaths(['candidate'])).rejects.toThrow('git ls-files のレコードが長すぎます');
    });
    it.each([
      ['Node_Modules', 'node_modules', true, false],
      ['café', 'cafe\u0301', false, true],
      ['cafe\u0301', 'café', false, true],
      ['École', 'école', true, false],
      ['Kelvin', 'kelvin', true, false],
      ['Kelvin', 'Kelvin', false, true],
      ['İ', 'i\u0307', true, false],
      ['pkg[1]', 'pkg[1]', false, false],
      ['Pkg[1]', 'pkg[1]', true, false],
      ['pkg\\name*?', 'pkg\\name*?', false, true],
      ['x;name', 'x;name', false, true],
      ['x;name', 'x;name', false, true],
      ['x`name', 'x`name', false, true],
      ['x`name', 'x`name', false, true],
    ])('FSの比較規則で候補を追跡判定する: %s / %s', async (tracked, candidate, ignoreCase, ignoreNormalization) => {
      const hash = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'tracked')).toString().trim();
      await runGit(directory, ['update-index', '-z', '--index-info'], `100644 ${hash}\t${tracked}/file\0`);
      expect(await git.trackedPaths([candidate, 'unrelated'], ignoreCase, ignoreNormalization)).toEqual(
        new Set([candidate]),
      );
      if (tracked !== candidate) {
        expect(await git.trackedPaths([candidate])).toEqual(new Set());
      }
    });
    it('実Gitで全体・直下・存在しないフォルダ・gitlinkを取得し、入力を検証する', async () => {
      await mkdir(join(directory, '日本 語/deep'), { recursive: true });
      await writeFile(join(directory, '日本 語/deep/a file'), 'one');
      await writeFile(join(directory, 'z'), 'two');
      await commitAll(directory, 'root');
      const commit = (await git.log(0, 1))[0]!;
      await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${commit.hash},sub`]);
      await gitAsAuthor(directory, ['commit', '-m', 'submodule']);
      const head = (await git.head())!;
      expect(await git.tree(head)).toEqual([
        { kind: 'gitlink', path: 'sub' },
        { kind: 'file', path: 'z' },
        { kind: 'folder', path: '日本 語' },
      ]);
      expect(await git.tree(head, '日本 語')).toEqual([{ kind: 'folder', path: '日本 語/deep' }]);
      expect(await git.tree(head, '日本 語/deep')).toEqual([{ kind: 'file', path: '日本 語/deep/a file' }]);
      expect(await git.tree(head, 'absent')).toEqual([]);
      await expect(git.tree('--help')).rejects.toThrow('フルハッシュ');
      await expect(git.tree(head, '../escape')).rejects.toThrow();
      await expect(git.tree('f'.repeat(40))).rejects.toThrow();
    });
    describe('実際の git 出力を読む', () => {
      it('空リポジトリと Git の失敗を区別する', async () => {
        expect(await git.log(0, 10)).toEqual([]);
        await expect(GitClient.resolve('/not/a/repository')).rejects.toThrow('cannot change to');
      });
      it('ルート、ページング、リネーム、日本語・空白、バイナリ、改行なしを扱う', async () => {
        const oldPath = '旧 file\t.ts';
        await writeFile(join(directory, oldPath), 'a\nb\nc');
        await writeFile(join(directory, 'binary'), Buffer.from([0, 1, 2]));
        await commitAll(directory, 'root\n\n本文');
        const root = (await git.log(0, 10))[0]!;
        expect(root).toBeDefined();
        expect(root.message).toContain('本文');
        expect(await git.files(root)).toContainEqual({ status: 'A', path: oldPath });
        expect(await git.patch(await git.parent(root), root.hash, { status: 'A', path: oldPath })).toContain(
          'No newline',
        );
        expect((await git.content(root.hash, 'binary')).binary).toBe(true);
        await rename(join(directory, oldPath), join(directory, '新 file.ts'));
        await commitAll(directory, 'rename');
        const latest = (await git.log(0, 1))[0]!;
        expect(await git.files(latest)).toEqual([{ status: 'R', oldPath, path: '新 file.ts' }]);
        expect((await git.log(1, 1))[0]?.hash).toBe(root.hash);
        expect(await git.workingLine(root.hash, oldPath, 2)).toEqual({ line: 2, path: '新 file.ts' });
        await writeFile(join(directory, '新 file.ts'), 'a\nchanged\nc');
        expect(await git.workingLine(latest.hash, '新 file.ts', 2)).toEqual({
          reason: '作業ツリーで変更または削除された行です',
        });
        await unlink(join(directory, '新 file.ts'));
        expect(await git.workingLine(latest.hash, '新 file.ts', 1)).toEqual({
          reason: '作業ツリーからファイルが削除されています',
        });
        expect(await git.branch()).toEqual({ name: 'main' });
      });
      it('マージは第1親を選ぶ', async () => {
        await writeFile(join(directory, 'base'), 'base');
        await commitAll(directory, 'base');
        await runGit(directory, ['checkout', '-b', 'topic']);
        await writeFile(join(directory, 'topic'), 'topic');
        await commitAll(directory, 'topic');
        await runGit(directory, ['checkout', 'main']);
        await writeFile(join(directory, 'main'), 'main');
        await commitAll(directory, 'main');
        await gitAsAuthor(directory, ['merge', '--no-ff', 'topic', '-m', 'merge']);
        const merge = (await git.log(0, 10))[0]!;
        expect(merge.parents).toHaveLength(2);
        expect(await git.parent(merge)).toBe(merge.parents[0]);
        expect(await git.files(merge)).toEqual([{ status: 'A', path: 'topic' }]);
      });
    });

    it('コピー・変更・削除と pathspec の特殊文字を識別する', async () => {
      await writeFile(join(directory, 'source [1].ts'), 'original\ncontent\n');
      await writeFile(join(directory, '-日本.txt'), 'before');
      await writeFile(join(directory, 'remove'), 'remove');
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'copy.ts'), 'original\ncontent\n');
      await writeFile(join(directory, '-日本.txt'), 'after');
      await unlink(join(directory, 'remove'));
      await commitAll(directory, 'after');
      const latest = (await git.log(0, 10))[0]!;
      expect(await git.files(latest)).toEqual(
        expect.arrayContaining([
          { status: 'C', oldPath: 'source [1].ts', path: 'copy.ts' },
          { status: 'M', path: '-日本.txt' },
          { status: 'D', path: 'remove' },
        ]),
      );
      expect((await git.content(latest.hash, 'source [1].ts')).text).toBe('original\ncontent\n');
      expect(
        await git.patch(await git.parent(latest), latest.hash, {
          status: 'C',
          oldPath: 'source [1].ts',
          path: 'copy.ts',
        }),
      ).toBe('');
      expect(await git.patch(await git.parent(latest), latest.hash, { status: 'M', path: '-日本.txt' })).toContain(
        '+after',
      );
    });

    it('コピー元の変更を対象コピーのhunkへ混入させず、detached HEADも表示する', async () => {
      const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
      await writeFile(join(directory, 'source'), original);
      await commitAll(directory, 'before');
      await writeFile(join(directory, 'copy'), original.replace('line 15', 'COPY CHANGE'));
      await writeFile(join(directory, 'source'), original.replace('line 1\n', 'SOURCE CHANGE\n'));
      await commitAll(directory, 'after');
      const commitInfo = (await git.log(0, 10))[0]!;
      const copy = (await git.files(commitInfo)).find((f) => f.path === 'copy')!;
      expect(copy).toMatchObject({ status: 'C', oldPath: 'source' });
      const patch = await git.patch(await git.parent(commitInfo), commitInfo.hash, copy);
      expect(patch).toContain('+COPY CHANGE');
      expect(patch).not.toContain('SOURCE CHANGE');
      await runGit(directory, ['checkout', '--detach', commitInfo.hash]);
      expect(await git.branch()).toEqual({ head: commitInfo.hash });
    });

    it('差し替え用のGit環境変数を除去して検出先を固定し、ロケールをCにする', async () => {
      const other = await repository();
      for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ]) {
        vi.stubEnv(key, 'hostile');
      }
      vi.stubEnv('GIT_DIR', join(other.directory, '.git'));
      vi.stubEnv('GIT_WORK_TREE', other.directory);
      vi.stubEnv('LC_ALL', 'ja_JP.UTF-8');
      vi.stubEnv('LANGUAGE', 'ja');
      const env = commandEnvironment();
      for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_CONFIG_PARAMETERS',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
      ]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env).toMatchObject({ LC_ALL: 'C', LANGUAGE: 'C', PATH: process.env.PATH });
      expect((await GitClient.resolve(directory)).root).toBe(directory);
    });
    it('色・空行省略・署名表示の設定にかかわらずhunkと行対応を読む', async () => {
      await writeFile(join(directory, 'file'), 'one\n\nthree\n');
      await commitAll(directory, 'before');
      const parent = (await git.head())!;
      await writeFile(join(directory, 'file'), 'ONE\n\nthree\n');
      await commitAll(directory, 'after');
      for (const [key, value] of [
        ['color.diff', 'always'],
        ['color.ui', 'always'],
        ['diff.suppressBlankEmpty', 'true'],
        ['log.showSignature', 'true'],
      ]) {
        await runGit(directory, ['config', key!, value!]);
      }
      const commitInfo = (await git.log(0, 1))[0]!;
      expect(commitInfo.subject).toBe('after');
      const file = (await git.files(commitInfo))[0]!;
      expect(file).toEqual({ status: 'M', path: 'file' });
      const patch = await git.patch(parent, commitInfo.hash, file);
      expect(patch).not.toContain('\u001b');
      expect(patch).toContain('\n \n');
      await writeFile(join(directory, 'file'), 'inserted\nONE\n\nthree\n');
      expect(await git.workingLine(commitInfo.hash, 'file', 3)).toEqual({ line: 4 });
    });
    it('POSIXのコロン・バックスラッシュを含む名前を読み取る', async () => {
      for (const path of process.platform === 'win32' ? ['a-b'] : ['a:b', 'a\\b']) {
        await writeFile(join(directory, path), path);
      }
      await commitAll(directory, 'paths');
      const commitInfo = (await git.log(0, 1))[0]!;
      for (const file of await git.files(commitInfo)) {
        expect((await git.content(commitInfo.hash, file.path)).text).toBe(file.path);
      }
    });
    it('防御用Git環境は保持し、設定注入とリポジトリ差し替えだけを除く', async () => {
      for (const key of ['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
        vi.stubEnv(key, 'defense');
      }
      for (const key of ['GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_KEY_123', 'GIT_CONFIG_VALUE_123']) {
        vi.stubEnv(key, 'hostile');
      }
      const env = commandEnvironment();
      expect(env).toMatchObject({
        GIT_CEILING_DIRECTORIES: 'defense',
        GIT_CONFIG_NOSYSTEM: 'defense',
        GIT_CONFIG_GLOBAL: 'defense',
        GIT_CONFIG_SYSTEM: 'defense',
      });
      for (const key of ['GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_KEY_123', 'GIT_CONFIG_VALUE_123']) {
        expect(env[key]).toBeUndefined();
      }
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : '/dev/null');
      vi.stubEnv('GIT_CONFIG_SYSTEM', process.platform === 'win32' ? 'NUL' : '/dev/null');
      vi.stubEnv('GIT_CEILING_DIRECTORIES', directory);
      const child = join(directory, 'child');
      await mkdir(child);
      await expect(GitClient.resolve(child)).rejects.toThrow('not a git repository');
    });
    it('PATHの絶対ディレクトリだけでgitを探索し、絶対パスを実行する', async () => {
      const first = await temporaryDirectory();
      const second = await temporaryDirectory();
      const name = process.platform === 'win32' ? 'git.exe' : 'git';
      const candidate = join(second, name);
      await writeFile(candidate, 'fixture');
      await chmod(candidate, 0o755);
      await mkdir(join(first, name));
      expect(resolveGitExecutable(['', '.', first, second].join(delimiter))).toBe(candidate);
      expect(() => resolveGitExecutable(['', '.', first].join(delimiter))).toThrow(
        'PATH に Git 実行ファイルが見つかりません',
      );
      expect(() => resolveGitExecutable('')).toThrow('PATH に Git 実行ファイルが見つかりません');
      const processes = gitProcesses();
      await git.head();
      const executable = processes.mock.calls[0]![0];
      expect(isAbsolute(executable)).toBe(true);
      expect(basename(executable)).toBe(name);
    });

    it('親ディレクトリがファイルになった作業パスは不一致として扱う', async () => {
      const { directory, git } = await repository();
      await mkdir(join(directory, 'dir'));
      await writeFile(join(directory, 'dir/file'), 'one');
      await commitAll(directory, 'one');
      const hash = (await git.head())!;
      await rm(join(directory, 'dir'), { recursive: true });
      await writeFile(join(directory, 'dir'), 'blocking');
      expect(await git.matchesWorking(hash, 'dir/file')).toBe(false);
    });

    it('Gitのリビジョンと脱出パスのガードで実行前に拒否する', async () => {
      const { git } = await repository();
      const processes = gitProcesses();
      const hash = 'a'.repeat(40);
      for (const promise of [
        git.patch('--output=x', hash, { status: 'A', path: 'file' }),
        git.patch(hash, '--output=x', { status: 'A', path: 'file' }),
        git.isReachable('--output=x'),
        git.hasCommit('--output=x'),
        git.mergeBase('--output=x', hash),
        git.mergeBase(hash, '--output=x'),
        git.isAncestor('--output=x', hash),
        git.isAncestor(hash, '--output=x'),
        git.workingLine('--output=x', 'file', 1),
        git.log(0, 1, '--output=x'),
        git.blob('--output=x', 'file'),
        git.isGitlink('--output=x', 'file'),
      ]) {
        await expect(promise).rejects.toThrow('リビジョンはフルハッシュで指定してください');
      }
      for (const promise of [
        git.blob(hash, '../x'),
        git.patch(hash, hash, { status: 'A', path: '../x' }),
        git.patch(hash, hash, { status: 'R', path: 'file', oldPath: '../x' }),
        git.workingLine(hash, '../x', 1),
      ]) {
        await expect(promise).rejects.toThrow('リポジトリ外のパスは開けません');
      }
      expect(processes).not.toHaveBeenCalled();
    });

    it('バイナリ化した作業ファイルに行番号を転送しない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'text');
      await commitAll(directory, 'text');
      const hash = (await git.head())!;
      await writeFile(join(directory, 'file'), Buffer.from([0, 1, 2]));
      expect(await git.workingLine(hash, 'file', 1)).toEqual({
        reason: '作業ツリーのファイルがバイナリのため対応行を特定できません',
      });
    });
    it('replace refsがあっても元のコミット・本文・差分を読む', async () => {
      await writeFile(join(directory, 'file'), 'original');
      await commitAll(directory, 'original');
      const original = (await git.log(0, 1))[0]!;
      await writeFile(join(directory, 'file'), 'replacement');
      await commitAll(directory, 'replacement');
      const replacement = (await git.log(0, 1))[0]!;
      await runGit(directory, ['replace', original.hash, replacement.hash]);
      expect((await git.log(0, 1, original.hash))[0]).toEqual(original);
      expect((await git.content(original.hash, 'file')).text).toBe('original');
      expect(await git.patch(await git.parent(original), original.hash, { status: 'A', path: 'file' })).toContain(
        '+original',
      );
    });
    it('オブジェクトと属性の取得元を差し替える環境変数を除く', () => {
      vi.stubEnv('GIT_SHALLOW_FILE', '/outside/shallow');
      vi.stubEnv('GIT_ATTR_SOURCE', 'HEAD~1');
      expect(commandEnvironment()).not.toHaveProperty('GIT_SHALLOW_FILE');
      expect(commandEnvironment()).not.toHaveProperty('GIT_ATTR_SOURCE');
    });
    it('Gitがない環境でもモジュールを読めて、初回実行をGitErrorで拒否する', async () => {
      vi.resetModules();
      vi.stubEnv('PATH', '');
      const client = await import('../src/git/client.ts');
      await expect(client.runGit(directory, ['status'])).rejects.toBeInstanceOf(client.GitError);
      await expect(client.runGit(directory, ['status'])).rejects.toThrow('PATH に Git 実行ファイルが見つかりません');
      vi.resetModules();
    });
  });

  describe('PR 用の Git 操作', () => {
    it.each(['', '--upload-pack=unsafe'])('fetch は不正なリモート名 %j を実行前に拒否する', async (remote) => {
      const { git } = await repository();
      const processes = gitProcesses();
      await expect(git.fetch(remote, 'refs/pull/12/head')).rejects.toThrow('リモート名が不正です');
      expect(processes).not.toHaveBeenCalled();
    });

    it('hasCommit は存在・不存在を区別し、プロセス起動失敗は例外で伝える', async () => {
      const { git, directory } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      expect(await git.hasCommit((await git.head())!)).toBe(true);
      expect(await git.hasCommit('f'.repeat(40))).toBe(false);
      gitProcesses().mockImplementationOnce(() => {
        throw new Error('spawn failed');
      });
      await expect(git.hasCommit('f'.repeat(40))).rejects.toThrow('spawn failed');
    });
    it('存在確認は遅延 fetch を無効にして行う', async () => {
      const { git } = await repository();
      const processes = gitProcesses();
      expect(await git.hasCommit('f'.repeat(40))).toBe(false);
      expect(processes.mock.calls[0]?.[2]).toMatchObject({ env: { GIT_NO_LAZY_FETCH: '1' } });
    });
    it('URL のないリモートを除いて取得先の候補を返す', async () => {
      const { git } = await repository();
      await runGit(git.root, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
      await runGit(git.root, ['config', 'remote.empty.tagopt', '--no-tags']);
      expect(await git.remotes()).toEqual([{ name: 'origin', url: 'https://github.com/owner/repo.git' }]);
    });
    it('リモート名と同じ相対 URL も候補として残す', async () => {
      const { git } = await repository();
      await runGit(git.root, ['remote', 'add', 'origin', 'origin']);
      expect(await git.remotes()).toEqual([{ name: 'origin', url: 'origin' }]);
    });
    it('ブランチ名の検証は同期で完了し、不正な名前を同期で拒否する', async () => {
      const { git } = await repository();
      expect(git.assertBranchName('main')).toBeUndefined();
      expect(() => git.assertBranchName('main:refs/heads/injected')).toThrow('ref 名が不正です');
    });
    it('isAncestor は非祖先で false を返し、リビジョンが存在しないエラーは例外で伝える', async () => {
      const { git, directory } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const first = (await git.head())!;
      await writeFile(join(directory, 'file'), 'two');
      await commitAll(directory, 'two');
      const second = (await git.head())!;
      expect(await git.isAncestor(first, second)).toBe(true);
      expect(await git.isAncestor(second, first)).toBe(false);
      await expect(git.isAncestor(first, 'f'.repeat(40))).rejects.toThrow();
    });
    it('remote が未登録なら空の一覧を返す', async () => {
      expect(await (await repository()).git.remotes()).toEqual([]);
    });

    describe('fetch の ref 境界', () => {
      it.each([
        '',
        '+refs/heads/main',
        'refs/heads/a+b',
        'refs/heads/a*',
        'refs/heads/a\0b',
        'refs/heads/a\x7fb',
        'refs/heads/main:refs/heads/injected',
        '--all',
        'HEAD',
        'refs/heads/a..b',
        'refs/heads/main.lock',
        'refs/.hidden/main',
        'refs/heads/main/',
        'refs/heads/main.',
        'refs/heads/a@{1}',
        'refs/heads/a\nnext',
      ])('ref %j を実行前に拒否する', async (ref) => {
        const { git } = await repository();
        const processes = gitProcesses();
        await expect(git.fetch('origin', ref)).rejects.toThrow();
        expect(processes).not.toHaveBeenCalled();
      });
    });
  });

  describe('バックグラウンド fetch', () => {
    it.each([false, true])(
      'FETCH_HEAD の既存有無 %s を変えずに取得し、非対話と timeout を指定する',
      async (existing) => {
        const { git, saved } = await pullRequestRepository();
        const fetchHead = join((await git.directories()).gitDir, 'FETCH_HEAD');
        if (existing) {
          await writeFile(fetchHead, 'user fetch head\n');
        }
        vi.stubEnv('GIT_SSH_COMMAND', 'custom-ssh -i key');
        vi.stubEnv('GIT_SSH', 'custom-ssh');
        vi.stubEnv('SSH_ASKPASS', 'askpass');
        await runGit(git.root, ['config', 'core.sshCommand', 'configured-ssh']);
        const processes = gitProcesses();
        await git.fetch('origin', 'refs/pull/12/head');
        const call = processes.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('fetch'))!;
        expect(call[1]).toEqual(
          expect.arrayContaining([
            '--no-write-fetch-head',
            '--no-tags',
            '--refmap=',
            '-c',
            'credential.interactive=false',
          ]),
        );
        expect(call[2]).toMatchObject({
          timeout: GIT_FETCH_TIMEOUT_MS,
          env: {
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '',
            SSH_ASKPASS_REQUIRE: 'never',
            GCM_INTERACTIVE: 'never',
          },
        });
        expect(call[2]?.env).toMatchObject({ GIT_SSH_COMMAND: 'custom-ssh -i key', GIT_SSH: 'custom-ssh' });
        expect(call[2]?.env).not.toHaveProperty('SSH_ASKPASS');
        expect(call[1]?.some((argument) => argument.startsWith('core.sshCommand='))).toBe(false);
        expect((await runGit(git.root, ['config', '--get', 'core.sshCommand'])).toString().trim()).toBe(
          'configured-ssh',
        );
        if (existing) {
          expect(await readFile(fetchHead, 'utf8')).toBe('user fetch head\n');
        } else {
          await expect(readFile(fetchHead)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        expect(await git.hasCommit(saved.commit)).toBe(true);
      },
    );
    it.each([undefined, 'custom-ssh'])('GIT_SSH_COMMAND が未設定でも SSH 設定 %s を補わない', async (ssh) => {
      const { git } = await pullRequestRepository();
      vi.stubEnv('GIT_SSH_COMMAND', undefined);
      vi.stubEnv('GIT_SSH', ssh);
      await runGit(git.root, ['config', 'core.sshCommand', 'configured-ssh -i key']);
      const processes = gitProcesses();
      await git.fetch('origin', 'refs/pull/12/head');
      const call = processes.mock.calls.find(([, args]) => Array.isArray(args) && args.includes('fetch'))!;
      expect(call[2]?.env).not.toHaveProperty('GIT_SSH_COMMAND');
      expect(call[2]?.env?.GIT_SSH).toBe(ssh);
      expect(call[1]?.some((argument) => argument.startsWith('core.sshCommand='))).toBe(false);
    });
    it.each(['refs/heads/main', 'oid'])('取得元 %s を受け付ける', async (ref) => {
      const { git, base } = await pullRequestRepository();
      await git.fetch('origin', ref === 'oid' ? base : ref);
      expect(await git.hasCommit(base)).toBe(true);
    });
  });
});

describe('runGitStream', () => {
  it('stderr が空のシグナル終了を理由として返す', async () => {
    const { directory } = await repository();
    const command = join(directory, 'signal-git');
    await writeFile(command, '#!/bin/sh\nkill -TERM $$\n');
    await chmod(command, 0o755);
    vi.spyOn(executable, 'gitExecutable').mockReturnValue(command);
    await expect(
      runGitStream(directory, ['--version'], async (source) => {
        for await (const chunk of source) {
          expect(chunk.length).toBe(0);
        }
      }),
    ).rejects.toThrow('SIGTERM');
  });
  it('Git の非ゼロ終了を stderr と終了コードつきで返す', async () => {
    const { directory } = await repository();
    await expect(
      runGitStream(directory, ['not-a-real-command'], async (source) => {
        for await (const chunk of source) {
          if (chunk.length) {
            throw new Error('失敗したコマンドが本文を返しました');
          }
        }
      }),
    ).rejects.toMatchObject({
      constructor: GitError,
      exitCode: 1,
    });
  });
  it('消費側の失敗で Git を終了し、最初のエラーを返す', async () => {
    const { directory } = await repository();
    const failure = new Error('disk full');
    await expect(
      runGitStream(directory, ['--version'], async (source) => {
        for await (const chunk of source) {
          expect(chunk.length).toBeGreaterThan(0);
          throw failure;
        }
      }),
    ).rejects.toBe(failure);
  });
  it('Git が先に失敗しても進行中の消費が止まるまで待つ', async () => {
    const { directory } = await repository();
    let finished = false;
    await expect(
      runGitStream(
        directory,
        ['probe'],
        async (source) => {
          const parts: Buffer[] = [];
          for await (const chunk of source) {
            parts.push(chunk);
          }
          expect(Buffer.concat(parts).toString()).toBe('payload');
          await new Promise((resolve) => setTimeout(resolve, 30));
          finished = true;
        },
        { config: ['alias.probe=!printf payload; exit 7'] },
      ),
    ).rejects.toBeInstanceOf(GitError);
    expect(finished).toBe(true);
  });
  it('無応答の Git を中断する', async () => {
    const { directory } = await repository();
    await expect(
      runGitStream(
        directory,
        ['cat-file', '--batch'],
        async (source) => {
          for await (const chunk of source) {
            expect(chunk).toBeDefined();
          }
        },
        { idleTimeout: 50 },
      ),
    ).rejects.toThrow('応答が途絶え');
  });
  it('書き込み待ちで無応答時間を超えても、次の blob を引き続き読める', async () => {
    const { directory } = await repository();
    const oid = (await runGit(directory, ['hash-object', '-w', '--stdin'], 'data')).toString('ascii').trim();
    await runGitStream(
      directory,
      ['cat-file', '--batch'],
      async (source, input) => {
        const reader = new GitStreamReader(source);
        for (let i = 0; i < 2; i++) {
          input.write(`${oid}\n`);
          expect((await reader.record(10, 256))?.toString()).toBe(`${oid} blob 4`);
          await copyBlob(reader, 4, async (chunk) => {
            expect(chunk.toString()).toBe('data');
            // Git ではなく消費側が待っている時間を、無応答に含めない。
            await new Promise((resolve) => setTimeout(resolve, 250));
          });
        }
      },
      { idleTimeout: 200 },
    );
  });
});

describe('runGitStream の失敗境界', () => {
  it('stderr だけの応答でも無応答タイマーを延長する', async () => {
    const { directory } = await repository();
    const output: Buffer[] = [];
    await runGitStream(
      directory,
      ['probe'],
      async (source) => {
        for await (const chunk of source) {
          output.push(chunk);
        }
      },
      {
        idleTimeout: 200,
        config: ['alias.probe=!for i in 1 2 3 4 5 6; do echo progress >&2; sleep 0.05; done; printf done'],
      },
    );
    expect(Buffer.concat(output).toString()).toBe('done');
  });
  it('起動失敗を GitError として返し消費側も終了させる', async () => {
    const { directory } = await repository();
    vi.spyOn(executable, 'gitExecutable').mockReturnValue(join(directory, 'missing-git'));
    let finished = false;
    await expect(
      runGitStream(directory, ['--version'], async (source) => {
        try {
          for await (const chunk of source) {
            if (chunk.length) {
              throw new Error('unexpected output');
            }
          }
        } finally {
          finished = true;
        }
      }),
    ).rejects.toBeInstanceOf(GitError);
    expect(finished).toBe(true);
  });
  it('stdin の書き込み完了待ちで Git が終了しても停止しない', async () => {
    const { directory } = await repository();
    let finished = false;
    await expect(
      runGitStream(
        directory,
        ['probe'],
        async (_source, input) => {
          try {
            await new Promise<void>((resolve, reject) =>
              input.write(Buffer.alloc(8 * 1024 * 1024), (error) => (error ? reject(error) : resolve())),
            );
          } finally {
            finished = true;
          }
        },
        { config: ['alias.probe=!exit 9'] },
      ),
    ).rejects.toSatisfy((error: unknown) =>
      error instanceof GitError
        ? error.exitCode === 9
        : error instanceof Error && 'code' in error && error.code === 'EPIPE',
    );
    expect(finished).toBe(true);
  });
});

describe('expandRevision のプロトコル検証', () => {
  it.each(['tree', 'oid'])('不正な %s 出力を拒否する', async (scenario) => {
    const { directory, git } = await repository();
    const hash = 'a'.repeat(40);
    const executablePath = join(directory, 'protocol-git');
    const type = scenario === 'tree' ? 'commit' : 'blob';
    await writeFile(
      executablePath,
      `#!/bin/sh
case " $* " in
  *" ls-tree "*) printf '100644 ${type} ${hash}\\tfile\\0' ;;
  *" cat-file "*) [ "$GIT_NO_LAZY_FETCH" = "1" ] || exit 7; while IFS= read -r oid; do printf '${'b'.repeat(40)} blob 0\\n\\n'; done ;;
esac
`,
    );
    await chmod(executablePath, 0o755);
    vi.spyOn(executable, 'gitExecutable').mockReturnValue(executablePath);
    await expect(
      (async () => {
        const entries: TreeRecord[] = [];
        await git.revisionFiles(hash, (record) => {
          entries.push(parseTreeRecord(record.toString('utf8')));
        });
        await git.expandRevision(
          hash,
          () => Promise.reject(new Error('不正な出力を書き込んではいけません')),
          () => true,
          entries,
        );
      })(),
    ).rejects.toThrow(scenario === 'tree' ? 'git ls-tree の形式が不正です' : 'git cat-file の形式が不正です');
  });
});
