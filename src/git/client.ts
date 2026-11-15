import { groupBy } from '../core/collections';
import { archivePathKey } from '../core/revisionArchive';
import { GitStreamReader, copyBlob, type RevisionBlob } from './blobStream';
import { isUtf8 } from 'node:buffer';
import type { Writable } from 'node:stream';
import { COMMAND_MAX_BUFFER_BYTES, commandEnvironment } from './environment';
import { gitExecutable } from './executable.mts';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open, realpath } from 'node:fs/promises';
import { isRevision, isRefName } from '../core/validation';
import { repoFile, OUTSIDE_REPOSITORY } from '../core/paths';
import { decodeText, isRegularFileWithin, isRealFileWithin, isUnreachablePathError } from './paths';
import { spawn, execFile } from 'node:child_process';
import {
  fileSide,
  GIT_GITLINK_MODE,
  GIT_EXECUTABLE_MODE,
  GIT_REGULAR_MODES,
  LOG_FORMAT,
  parseLog,
  parseNameStatus,
  parseTree,
  type TreeEntry,
  type TreeRecord,
  type ChangedFile,
  type Commit,
} from '../core/gitParsing';
import { DIFF_CONTEXT_LINES, mapLine, type LineMapping } from '../core/diff';

// 自動更新キューを無期限に止めず、通常のネットワーク待ちには30秒の猶予を与える。
export const GIT_FETCH_TIMEOUT_MS = 30_000;
// 総処理時間ではなく、Git からデータが届かない時間を制限する。
export const GIT_EXPANSION_IDLE_TIMEOUT_MS = 30_000;
const GIT_FATAL_EXIT_CODE = 128;
const GIT_REMOTE_NOT_FOUND_EXIT_CODE = 2;
const TREE_RECORD_MAX_BYTES = 1024 * 1024;
const BATCH_HEADER_MAX_BYTES = 256;
const NEWLINE_BYTE = 10;
const SLASH_BYTE = 47;

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | string | undefined,
  ) {
    super(`git ${args[0] ?? ''}: ${stderr.trim() || 'コマンドが失敗しました'}`);
  }
}
export function runGit(
  repo: string,
  args: readonly string[],
  input: string | Buffer = '',
  options: { env?: NodeJS.ProcessEnv; timeout?: number; config?: readonly string[] } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((done, reject) => {
    const child = execFile(
      gitExecutable(),
      gitArguments(repo, args, options.config),
      {
        cwd: tmpdir(),
        encoding: 'buffer',
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: options.env ?? commandEnvironment(),
        timeout: options.timeout,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(args, stderr.toString('utf8') || error.message, error.code ?? undefined));
        } else {
          done(stdout);
        }
      },
    );
    child.stdin?.on('error', () => {
      /* コマンド失敗は execFile のコールバックで通知する。 */
    });
    child.stdin?.end(input);
  }).catch((error: unknown) => {
    throw error instanceof GitError
      ? error
      : new GitError(args, error instanceof Error ? error.message : String(error), undefined);
  });
}
function gitArguments(repo: string, args: readonly string[], config: readonly string[] = []): string[] {
  return [
    '--no-pager',
    '--no-replace-objects',
    '--literal-pathspecs',
    '-c',
    'core.quotepath=false',
    '-c',
    'color.ui=false',
    '-c',
    'diff.suppressBlankEmpty=false',
    '-C',
    repo,
    ...config.flatMap((value) => ['-c', value]),
    ...args,
  ];
}
export async function runGitStream(
  repo: string,
  args: readonly string[],
  consume: (source: AsyncIterable<Buffer>, input: Writable) => Promise<void>,
  options: { env?: NodeJS.ProcessEnv; idleTimeout?: number; config?: readonly string[] } = {},
): Promise<void> {
  const child = spawn(gitExecutable(), gitArguments(repo, args, options.config), {
    cwd: tmpdir(),
    env: options.env ?? commandEnvironment(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    clearTimeout(timer);
    if (options.idleTimeout !== undefined) {
      timer = setTimeout(() => {
        expired = true;
        child.kill();
        child.stdout.destroy(new Error('Git からの応答が途絶えました'));
      }, options.idleTimeout);
    }
  };
  child.stdin.on('error', () => {
    // error イベントでプロセスを落とさず、書込コールバックと Git の終了で呼び出し元へ伝える。
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    if (timer !== undefined) {
      touch();
    }
    stderr = (stderr + data).slice(-COMMAND_MAX_BUFFER_BYTES);
  });
  const completed = new Promise<void>((done, reject) => {
    child.once('error', (error) => reject(new GitError(args, error.message, undefined)));
    child.once('close', (code, signal) => {
      if (code === 0 && !expired) {
        done();
      } else {
        reject(
          new GitError(
            args,
            expired ? 'Git からの応答が途絶えました' : stderr || signal || 'コマンドが失敗しました',
            code ?? undefined,
          ),
        );
      }
    });
  });
  async function* source(): AsyncIterable<Buffer> {
    const iterator = child.stdout[Symbol.asyncIterator]();
    try {
      while (true) {
        // 書き込みのバックプレッシャー中は Git の無応答とみなさない。
        touch();
        const next = await iterator.next();
        clearTimeout(timer);
        timer = undefined;
        if (next.done) {
          return;
        }
        yield next.value as Buffer;
      }
    } finally {
      clearTimeout(timer);
      timer = undefined;
    }
  }
  const consumed = Promise.resolve()
    .then(() => consume(source(), child.stdin))
    .finally(() => child.stdin.end());
  try {
    await Promise.all([completed, consumed]);
  } catch (error) {
    child.kill();
    child.stdout.destroy();
    child.stdin.destroy(error instanceof Error ? error : new Error(String(error)));
    // ファイル書き込みが終わる前に一時ディレクトリを削除しない。
    await Promise.allSettled([completed, consumed]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
// Windows の 32,767 文字制限に対し、引用・エスケープで倍増しても固定引数分を残す。
export const PATHSPEC_BATCH_MAX_BYTES = 12 * 1024;
export function splitPathspecs(specs: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = 0;
  for (const spec of specs) {
    const bytes = Buffer.byteLength(spec) + 1;
    if (bytes > PATHSPEC_BATCH_MAX_BYTES) {
      throw new Error('git pathspec が引数長の上限を超えました');
    }
    if (size + bytes > PATHSPEC_BATCH_MAX_BYTES) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(spec);
    size += bytes;
  }
  if (batch.length) {
    batches.push(batch);
  }
  return batches;
}
let normalizedAscii: Set<string> | undefined;
function normalizationAsciiVariants(): Set<string> {
  if (!normalizedAscii) {
    normalizedAscii = new Set();
    // 正規化結果の全体が ASCII になる非 ASCII 文字の逆方向も検索する。
    for (let code = 128; code <= 0x10ffff; code++) {
      const character = String.fromCodePoint(code);
      for (const form of ['NFC', 'NFD'] as const) {
        const normalized = character.normalize(form);
        if ([...normalized].every((part) => part.charCodeAt(0) < 128)) {
          for (const part of normalized) {
            normalizedAscii.add(part);
          }
        }
      }
    }
  }
  return normalizedAscii;
}
export class GitClient {
  constructor(readonly root: string) {}
  private text(args: readonly string[]): Promise<string> {
    return runGitText(this.root, args);
  }
  static async resolve(directory: string): Promise<GitClient> {
    const root = await realpath((await runGitText(directory, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, ''));
    return new GitClient(root);
  }
  async trackedPaths(
    candidates: readonly string[],
    caseInsensitive = false,
    normalizationInsensitive = false,
  ): Promise<Set<string>> {
    const paths = new Set<string>();
    if (!candidates.length) {
      return paths;
    }
    const key = (path: string): string => archivePathKey(path, caseInsensitive, normalizationInsensitive);
    const byKey = groupBy(candidates, key);
    const specs = candidates.flatMap((path) => {
      if (!caseInsensitive && !normalizationInsensitive) {
        return [`:(top,literal)${path}`];
      }
      // Git の icase は Unicode の大小文字・正規化を扱わないため、非 ASCII 部分を広く取得し、下で FS のキーに照合する。
      // 分解形の ASCII 基底文字も合成してから広げ、café と café の照合を保つ。
      const pattern = (normalizationInsensitive ? path.normalize('NFC') : path)
        .split('/')
        .map((part) => {
          if (caseInsensitive && /[^\u0020-\u007e]/.test(part)) {
            return '*';
          }
          return [...part]
            .map((character) => {
              if (
                /[^\u0020-\u007e]/.test(character) ||
                (caseInsensitive && /[kK]/.test(character)) ||
                (normalizationInsensitive && normalizationAsciiVariants().has(character))
              ) {
                return '*';
              }
              return /[\\*?[\]]/.test(character) ? `\\${character}` : character;
            })
            .join('');
        })
        .join('/');
      const magic = caseInsensitive ? 'top,glob,icase' : 'top,glob';
      return [`:(${magic})${pattern}`, `:(${magic})${pattern}/**`];
    });
    for (const batch of splitPathspecs([...new Set(specs)])) {
      await runGitStream(
        this.root,
        ['--no-literal-pathspecs', 'ls-files', '--cached', '-z', '--', ...batch],
        async (source) => {
          const reader = new GitStreamReader(source, 'git ls-files');
          for (
            let record = await reader.record(0, TREE_RECORD_MAX_BYTES);
            record;
            record = await reader.record(0, TREE_RECORD_MAX_BYTES)
          ) {
            // 不正 UTF-8 のファイル名でも、有効な親パスは追跡対象として照合する。
            for (let end = record.length; end > 0; end = record.lastIndexOf(SLASH_BYTE, end - 1)) {
              const prefix = record.subarray(0, end);
              if (isUtf8(prefix)) {
                for (const candidate of byKey.get(key(prefix.toString('utf8'))) ?? []) {
                  paths.add(candidate);
                }
              }
            }
          }
        },
        { idleTimeout: GIT_EXPANSION_IDLE_TIMEOUT_MS },
      );
    }
    return paths;
  }
  async revisionFiles(rev: string, visit: (record: Buffer) => void | Promise<void>): Promise<void> {
    assertRevision(rev);
    await runGitStream(
      this.root,
      ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', rev],
      async (tree) => {
        const entries = new GitStreamReader(tree, 'git ls-tree');
        for (
          let record = await entries.record(0, TREE_RECORD_MAX_BYTES);
          record;
          record = await entries.record(0, TREE_RECORD_MAX_BYTES)
        ) {
          await visit(record);
        }
      },
      { idleTimeout: GIT_EXPANSION_IDLE_TIMEOUT_MS },
    );
  }
  async expandRevision(
    rev: string,
    write: (entry: RevisionBlob, body: (write: (chunk: Buffer) => Promise<void>) => Promise<void>) => Promise<void>,
    include: (path: string) => boolean,
    entries: readonly TreeRecord[],
    missing: (entry: TreeRecord) => void = () => {},
  ): Promise<void> {
    assertRevision(rev);
    await runGitStream(
      this.root,
      ['cat-file', '--batch'],
      async (source, input) => {
        const blobs = new GitStreamReader(source, 'git cat-file');
        const consume = async (entry: TreeRecord): Promise<void> => {
          if (!GIT_REGULAR_MODES.includes(entry.mode) || !include(entry.path)) {
            return;
          }
          // write の完了は drain と違い、途中終了時もエラーで必ず完了する。
          await new Promise<void>((resolve, reject) =>
            input.write(`${entry.hash}\n`, (error) => (error ? reject(error) : resolve())),
          );
          const header = (await blobs.record(NEWLINE_BYTE, BATCH_HEADER_MAX_BYTES))?.toString('ascii');
          if (header === `${entry.hash} missing`) {
            missing(entry);
            return;
          }
          const blob = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/.exec(header ?? '');
          const size = Number(blob?.[2]);
          if (!blob || blob[1] !== entry.hash || !Number.isSafeInteger(size)) {
            throw new Error('git cat-file の形式が不正です');
          }
          await write({ path: entry.path, size, executable: entry.mode === GIT_EXECUTABLE_MODE }, (sink) =>
            copyBlob(blobs, size, sink),
          );
        };
        for (const entry of entries) {
          await consume(entry);
        }
      },
      { idleTimeout: GIT_EXPANSION_IDLE_TIMEOUT_MS, env: { ...commandEnvironment(), GIT_NO_LAZY_FETCH: '1' } },
    );
  }
  async hasCommit(rev: string): Promise<boolean> {
    assertRevision(rev);
    try {
      await runGit(this.root, ['cat-file', '-e', '--end-of-options', `${rev}^{commit}`], '', {
        env: { ...commandEnvironment(), GIT_NO_LAZY_FETCH: '1' },
      });
      return true;
    } catch (error) {
      if (error instanceof GitError && (error.exitCode === 1 || error.exitCode === GIT_FATAL_EXIT_CODE)) {
        return false;
      }
      throw error;
    }
  }
  async fetch(remote: string, ref: string): Promise<void> {
    assertRemote(remote);
    // fetch の入力は取得元だけに制限し、+ や : によるローカル ref の更新を許可しない。
    if (!isRevision(ref)) {
      this.assertRefName(ref);
    }
    // バックグラウンド取得で認証ダイアログを出さず、資格情報マネージャーの入力待ちも防ぐ。
    const env: NodeJS.ProcessEnv = {
      ...commandEnvironment(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GCM_INTERACTIVE: 'never',
    };
    delete env.SSH_ASKPASS;
    // 利用者の remote-tracking ref と FETCH_HEAD を裏の取得で変更しない。
    await runGit(this.root, ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--', remote, ref], '', {
      env,
      timeout: GIT_FETCH_TIMEOUT_MS,
      config: ['credential.interactive=false'],
    });
  }
  assertBranchName(name: string): void {
    this.assertRefName(`refs/heads/${name}`);
  }
  private assertRefName(ref: string): void {
    if (!isRefName(ref)) {
      throw new Error('ref 名が不正です');
    }
  }
  async mergeBase(base: string, head: string): Promise<string> {
    assertRevision(base);
    assertRevision(head);
    return (await this.text(['merge-base', '--end-of-options', base, head])).trim();
  }
  async isAncestor(base: string, head: string): Promise<boolean> {
    assertRevision(base);
    assertRevision(head);
    try {
      await this.text(['merge-base', '--is-ancestor', '--end-of-options', base, head]);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }
  async remotes(): Promise<{ name: string; url: string }[]> {
    const names = (await this.text(['remote'])).trim().split('\n').filter(Boolean);
    const remotes = await Promise.all(
      names.map(async (name) => {
        try {
          // get-url は URL 設定がない場合に名前自体を返す Git の版がある。
          if (!(await this.text(['config', '--get', `remote.${name}.url`])).trim()) {
            return undefined;
          }
          const url = (await this.text(['remote', 'get-url', '--', name])).trim();
          return url ? { name, url } : undefined;
        } catch (error) {
          if (
            error instanceof GitError &&
            (error.exitCode === 1 || error.exitCode === GIT_REMOTE_NOT_FOUND_EXIT_CODE)
          ) {
            return undefined;
          }
          throw error;
        }
      }),
    );
    return remotes.filter((remote) => remote !== undefined);
  }

  async directories(): Promise<{ gitDir: string; commonDir: string }> {
    const gitDir = await this.text(['rev-parse', '--absolute-git-dir']);
    const commonDir = await this.text(['rev-parse', '--git-common-dir']);
    return {
      gitDir: resolve(this.root, gitDir.replace(/\r?\n$/, '')),
      commonDir: resolve(this.root, commonDir.replace(/\r?\n$/, '')),
    };
  }
  async ignoredPaths(paths: readonly string[]): Promise<Set<string>> {
    if (!paths.length) {
      return new Set();
    }
    let output: Buffer;
    try {
      // check-ignore は literal pathspec magic を受け付けない。
      output = await runGit(
        this.root,
        ['--no-literal-pathspecs', 'check-ignore', '--no-index', '-z', '--stdin'],
        paths.join('\0') + '\0',
      );
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) {
        return new Set();
      }
      throw error;
    }
    const ignored = output.toString('utf8').split('\0').filter(Boolean);
    const specs = [...new Set(ignored.map((path) => path.split('/', 1)[0]!))];
    const pathspecs =
      specs.reduce((size, spec) => size + Buffer.byteLength(spec) + 1, 0) <= PATHSPEC_BATCH_MAX_BYTES
        ? ['--', ...specs]
        : [];
    const tracked = new Set<string>();
    for (const file of (await this.text(['ls-files', '-c', '-z', '-i', '--exclude-standard', ...pathspecs])).split(
      '\0',
    )) {
      for (let end = file.length; end > 0; end = file.lastIndexOf('/', end - 1)) {
        tracked.add(file.slice(0, end));
      }
    }
    return new Set(ignored.filter((path) => !tracked.has(path)));
  }
  async head(): Promise<string | undefined> {
    try {
      return (await this.text(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) {
        return undefined;
      }
      throw error;
    }
  }
  async log(skip: number, limit: number, revision?: string): Promise<Commit[]> {
    const start = revision ?? (await this.head());
    if (!start) {
      return [];
    }
    assertRevision(start);
    return parseLog(
      await this.text([
        'log',
        '--no-color',
        '--no-show-signature',
        `--skip=${skip}`,
        `--max-count=${limit}`,
        '-z',
        `--format=${LOG_FORMAT}`,
        '--end-of-options',
        start,
        '--',
      ]),
    );
  }
  async parent(commit: Commit): Promise<string> {
    assertRevision(commit.hash);
    if (commit.parents[0]) {
      assertRevision(commit.parents[0]);
    }
    return commit.parents[0] ?? (await this.text(['hash-object', '-t', 'tree', '--stdin'])).trim();
  }
  async files(commit: Commit): Promise<ChangedFile[]> {
    assertRevision(commit.hash);
    // 未変更のコピー元も探索し、コピーが追加ファイルとして扱われて旧側の参照を失うのを防ぐ。
    return parseNameStatus(
      await this.text([
        'diff',
        '--no-color',
        '--name-status',
        '-z',
        '-M',
        '-C',
        '--find-copies-harder',
        '--end-of-options',
        await this.parent(commit),
        commit.hash,
        '--',
      ]),
    );
  }
  async tree(rev: string, path = ''): Promise<TreeEntry[]> {
    assertRevision(rev);
    if (path) {
      repoFile(this.root, path);
    }
    return parseTree(
      await this.text(['ls-tree', '-z', '--full-tree', '--end-of-options', rev, ...(path ? ['--', `${path}/`] : [])]),
    );
  }
  async isGitlink(rev: string, path: string): Promise<boolean> {
    assertRevision(rev);
    repoFile(this.root, path);
    return (await this.text(['ls-tree', '-z', '--full-tree', '--end-of-options', rev, '--', path])).startsWith(
      `${GIT_GITLINK_MODE} `,
    );
  }
  async content(rev: string, path: string): Promise<{ text: string; binary: boolean }> {
    const content = await this.blob(rev, path);
    return { text: decodeText(content), binary: content.includes(0) };
  }
  async patch(parent: string, commit: string, file: ChangedFile, context = DIFF_CONTEXT_LINES): Promise<string> {
    assertRevision(parent);
    assertRevision(commit);
    repoFile(this.root, file.path);
    const options = [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      `--unified=${context}`,
      '--end-of-options',
    ];
    // コピー元も変更された場合に別ファイルの節が混ざらないよう、両側がある場合は blob 同士を比較する。
    const old = fileSide(file, 'old');
    const next = fileSide(file, 'new');
    if (!old.empty && !next.empty) {
      repoFile(this.root, old.path);
      return this.text([...options, `${parent}:${old.path}`, `${commit}:${next.path}`, '--']);
    }
    return this.text([...options, parent, commit, '--', file.path]);
  }
  async blob(rev: string, path: string): Promise<Buffer> {
    assertRevision(rev);
    repoFile(this.root, path);
    return runGit(this.root, ['show', '--no-ext-diff', '--no-textconv', '--end-of-options', `${rev}:${path}`]);
  }
  async matchesWorking(rev: string, path: string): Promise<boolean> {
    const absolute = repoFile(this.root, path);
    try {
      if (!(await isRegularFileWithin(this.root, absolute))) {
        return false;
      }
      // 検査から open までのリンク差し替えの窓を狭め、検査した実体を O_NOFOLLOW で開く。
      const canonical = await realpath(absolute);
      if (!(await isRealFileWithin(this.root, canonical))) {
        return false;
      }
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        return (await file.stat()).isFile() && (await this.blob(rev, path)).equals(await file.readFile());
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isUnreachablePathError(error)) {
        return false;
      }
      throw error;
    }
  }
  async isReachable(rev: string): Promise<boolean> {
    assertRevision(rev);
    const head = await this.head();
    if (!head) {
      return false;
    }
    try {
      return (await this.hasCommit(rev)) && (await this.isAncestor(rev, head));
    } catch (error) {
      if (error instanceof GitError && (error.exitCode === 1 || error.exitCode === GIT_FATAL_EXIT_CODE)) {
        return false;
      }
      throw error;
    }
  }

  async branch(): Promise<{ name: string } | { head: string }> {
    try {
      return { name: (await this.text(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() };
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1) {
        throw error;
      }
      const head = await this.head();
      if (!head) {
        throw new Error('HEAD が存在しません', { cause: error });
      }
      return { head };
    }
  }
  async workingLine(rev: string, path: string, line: number): Promise<LineMapping> {
    assertRevision(rev);
    repoFile(this.root, path);
    const files = parseNameStatus(
      await this.text(['diff', '--no-color', '--name-status', '-z', '-M', '--end-of-options', rev, '--']),
    );
    const change = files.find((file) => fileSide(file, 'old').path === path);
    if (change?.status === 'D') {
      try {
        if (!(await isRealFileWithin(this.root, repoFile(this.root, path)))) {
          return { reason: OUTSIDE_REPOSITORY };
        }
      } catch {
        /* 削除済みパスは通常の削除理由を返す。 */
      }
      return mapLine('', line, { deleted: true });
    }
    const workingPath = change?.status === 'R' ? change.path : path;
    const patch = await this.text([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      '-M',
      '--end-of-options',
      rev,
      '--',
      ...new Set([path, workingPath]),
    ]);
    if (/^(?:Binary files |GIT binary patch)/m.test(patch)) {
      return { reason: '作業ツリーのファイルがバイナリのため対応行を特定できません' };
    }
    return mapLine(patch, line, workingPath === path ? {} : { renamedTo: workingPath });
  }
}

export function runGitText(repo: string, args: readonly string[]): Promise<string> {
  return runGit(repo, args).then((output) => output.toString('utf8'));
}
export function isNotRepository(error: unknown): boolean {
  return (
    error instanceof GitError &&
    error.exitCode === GIT_FATAL_EXIT_CODE &&
    ['not a git repository', 'cannot change to', 'must be run in a work tree'].some((message) =>
      error.stderr.includes(message),
    )
  );
}
export function assertRevision(value: string): void {
  if (!isRevision(value)) {
    throw new Error('リビジョンはフルハッシュで指定してください');
  }
}
export type GitFactory = (repo: string) => GitClient;

function assertRemote(remote: string): void {
  if (!remote || remote.startsWith('-')) {
    throw new Error('リモート名が不正です');
  }
}
