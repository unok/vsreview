import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { UncommittedChange, UncommittedChanges, UncommittedKind } from '../core/uncommitted';
import { isRecord } from '../core/validation';
import { GitClient, GitError, runGit } from './client';
import { commandEnvironment } from './environment';

const SNAPSHOT_NAME = 'VSReview';
const SNAPSHOT_EMAIL = 'snapshot@vsreview.invalid';
// 内容が同じなら SHA も同じにし、現在時刻だけで変更済みと判定されるのを防ぐ。
const SNAPSHOT_DATE = '@946684800 +0000';
const SNAPSHOT_MESSAGE = 'VSReview uncommitted snapshot';
const INDEX_FILE = 'index';
// 一時 index の操作で sharedindex.* が gitDir に作られるのを防ぐ。
const INDEX_CONFIG = ['core.splitIndex=false'];
const SNAPSHOT_RETRY_DELAYS_MS = [100, 300] as const;

export type CaptureUncommitted = (git: GitClient) => Promise<UncommittedChanges>;
export const captureUncommittedChanges: CaptureUncommitted = (git) =>
  createUncommittedChanges(git, new Date().toISOString());

export async function createUncommittedChanges(git: GitClient, createdAt: string): Promise<UncommittedChanges> {
  // C ロケールの Git が read で読む小さなファイルの add の short read だけ、初回を含め最大3回試す。
  // 大きいファイルの同じ書き込み競合は別のエラーになるため再試行の対象外で、従来どおり呼び出し元の通知に任せる。
  // 部分更新された一時 index を捨て、比較元の HEAD と実 index から取り直す。
  for (let attempt = 0; ; attempt++) {
    try {
      return await createSnapshot(git, createdAt);
    } catch (error) {
      const delay = SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (
        delay === undefined ||
        !(error instanceof GitError) ||
        error.args[0] !== 'add' ||
        !error.stderr.includes('short read while indexing')
      ) {
        throw error;
      }
      await sleep(delay);
    }
  }
}
async function createSnapshot(git: GitClient, createdAt: string): Promise<UncommittedChanges> {
  const head = await git.head();
  const temporary = await mkdtemp(join(tmpdir(), 'vsreview-index-'));
  try {
    const index = join(temporary, INDEX_FILE);
    const { gitDir } = await git.directories();
    const indexTime = await copyIndex(join(gitDir, INDEX_FILE), index);
    const env = {
      ...commandEnvironment(),
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: SNAPSHOT_NAME,
      GIT_AUTHOR_EMAIL: SNAPSHOT_EMAIL,
      GIT_AUTHOR_DATE: SNAPSHOT_DATE,
      GIT_COMMITTER_NAME: SNAPSHOT_NAME,
      GIT_COMMITTER_EMAIL: SNAPSHOT_EMAIL,
      GIT_COMMITTER_DATE: SNAPSHOT_DATE,
    };
    const options = { env, config: INDEX_CONFIG };
    const indexTree = (await runGit(git.root, ['write-tree'], '', options)).toString('utf8').trim();
    // コピーや write-tree の新しい時刻で、同時刻・同サイズの変更を未変更と誤認させない。
    if (indexTime) {
      await utimes(index, indexTime, indexTime);
    }
    await runGit(git.root, ['add', '-A'], '', options);
    const workingTree = (await runGit(git.root, ['write-tree'], '', options)).toString('utf8').trim();
    const commit = async (tree: string, parent: string | undefined): Promise<string> =>
      (
        await runGit(
          git.root,
          // commit.gpgSign=true の環境でも署名を試みずに生成する。
          ['commit-tree', '--no-gpg-sign', '-m', SNAPSHOT_MESSAGE, ...(parent ? ['-p', parent] : []), tree],
          '',
          options,
        )
      )
        .toString('utf8')
        .trim();
    const stagedHash = await commit(indexTree, head);
    // 未ステージの判定を HEAD の移動から独立させるため、stagedHash を親にしない。
    const indexHash = await commit(indexTree, undefined);
    const unstagedHash = await commit(workingTree, indexHash);
    return {
      ...(head ? { head } : {}),
      createdAt,
      staged: await change(git, 'staged', stagedHash),
      unstaged: await change(git, 'unstaged', unstagedHash),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function copyIndex(source: string, destination: string): Promise<Date | undefined> {
  try {
    const { mtime } = await stat(source);
    await copyFile(source, destination);
    return mtime;
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}
async function change(git: GitClient, kind: UncommittedKind, hash: string): Promise<UncommittedChange> {
  const commit = (await git.log(0, 1, hash))[0];
  if (!commit) {
    throw new Error('スナップショットのコミットが存在しません');
  }
  return { kind, commit, parent: await git.parent(commit), files: await git.files(commit) };
}
