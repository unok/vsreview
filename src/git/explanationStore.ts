import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SerialQueue } from '../core/collections';
import { isStoredExplanation, type StoredExplanation } from '../core/explanations';
import { archiveEvictions } from '../core/revisionArchive';
import { isRecord } from '../core/validation';
import { directory, existingDirectory } from './paths';
import { hashId, repositoryId } from './repositoryId';

// リポジトリごとに保存する比較の数。超えたら最終更新の古いものから消す。
export const EXPLANATION_MAX_COUNT = 50;
const FILE_SUFFIX = '.json';
const TEMPORARY_PREFIX = '.tmp-';

export type ExplanationRead =
  | { kind: 'found'; explanation: StoredExplanation }
  | { kind: 'none' }
  // 壊れたファイルはその比較だけ読み込めないとし、再生成での上書きに任せる。
  | { kind: 'unreadable' };

interface MemoryEntry {
  explanation: StoredExplanation;
  updated: number;
}

export class ExplanationStore {
  private readonly queue = new SerialQueue();
  private readonly root: string | undefined;
  // has を同期的に引くため、保存済みの比較のファイル名をリポジトリごとに持つ。
  private readonly saved = new Map<string, Set<string>>();
  private readonly memory = new Map<string, Map<string, MemoryEntry>>();
  constructor(
    storage: string | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.root = storage === undefined ? undefined : join(storage, 'explanations');
  }
  // false なら再起動で消えることをビューに示す。
  get persistent(): boolean {
    return this.root !== undefined;
  }
  has(repo: string, comparison: string): boolean {
    return this.root === undefined
      ? Boolean(this.memory.get(repo)?.has(comparison))
      : Boolean(this.saved.get(repo)?.has(fileName(comparison)));
  }
  // 保存済みの比較を読み込み、中断した書き込みの一時ファイルを掃除する。
  load(repo: string): Promise<void> {
    const root = this.root;
    if (root === undefined) {
      return Promise.resolve();
    }
    return this.queue.run(async () => {
      const parent = await savedDirectory(root, repo);
      const names = new Set<string>();
      this.saved.set(repo, names);
      if (parent === undefined) {
        return;
      }
      for (const entry of await entries(parent)) {
        // 同じ形の名前のディレクトリなどは保存した解説として扱わず、消しもしない。
        if (!entry.isFile()) {
          continue;
        }
        if (entry.name.startsWith(TEMPORARY_PREFIX)) {
          await rm(join(parent, entry.name), { force: true });
        } else if (isExplanationFile(entry.name)) {
          names.add(entry.name);
        }
      }
    });
  }
  read(repo: string, comparison: string): Promise<ExplanationRead> {
    const root = this.root;
    // 件数の整理が消したファイルを索引に戻さず、待たれていない書き込みの後の値を返すよう、書き込みと同じ順序で読む。
    return this.queue.run(async () => {
      if (root !== undefined) {
        return this.readFile(root, repo, comparison);
      }
      const entry = this.memory.get(repo)?.get(comparison);
      // 読み戻した値を変更しても保持内容を変えない。
      return entry ? { kind: 'found', explanation: structuredClone(entry.explanation) } : { kind: 'none' };
    });
  }
  private async readFile(root: string, repo: string, comparison: string): Promise<ExplanationRead> {
    const name = fileName(comparison);
    const parent = await savedDirectory(root, repo);
    let content: string | undefined;
    if (parent !== undefined) {
      try {
        // ディレクトリやリンクなど通常ファイルでない位置は、壊れた解説として扱いリンク先を読まない。
        if (!(await lstat(join(parent, name))).isFile()) {
          this.saved.get(repo)?.delete(name);
          return { kind: 'unreadable' };
        }
        content = await readFile(join(parent, name), 'utf8');
      } catch (error) {
        // 権限などの失敗は呼び出し元へ伝える。
        if (!isRecord(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (content === undefined) {
      this.saved.get(repo)?.delete(name);
      return { kind: 'none' };
    }
    this.saved.get(repo)?.add(name);
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return { kind: 'unreadable' };
    }
    return isStoredExplanation(value) && value.comparison === comparison
      ? { kind: 'found', explanation: value }
      : { kind: 'unreadable' };
  }
  write(repo: string, value: StoredExplanation): Promise<void> {
    // 検証後・書き込み待ちの間に引数が変更されても、検証した内容を保存する。
    const explanation = structuredClone(value);
    if (!isStoredExplanation(explanation)) {
      return Promise.reject(new Error('保存する解説の形式が不正です'));
    }
    return this.queue.run(async () => {
      const updated = this.now();
      if (this.root === undefined) {
        const values = this.memory.get(repo) ?? new Map<string, MemoryEntry>();
        values.set(explanation.comparison, { explanation, updated });
        this.memory.set(repo, values);
        for (const key of archiveEvictions(
          [...values].map(([key, entry]) => ({ key, lastUsed: entry.updated })),
          EXPLANATION_MAX_COUNT,
          new Set([explanation.comparison]),
        )) {
          values.delete(key);
        }
        return;
      }
      // 保存先がリンクならリンク先へ書かないよう、階層ごとにディレクトリか確かめる。
      await directory(this.root);
      const parent = join(this.root, repositoryId(repo));
      await directory(parent);
      const name = fileName(explanation.comparison);
      // 読み込みが書きかけの内容を見ないよう、完成した一時ファイルを rename で差し替える。
      const temporary = join(parent, `${TEMPORARY_PREFIX}${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(explanation), { flag: 'wx' });
        const time = new Date(updated);
        await utimes(temporary, time, time);
        await rename(temporary, join(parent, name));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const names = this.saved.get(repo) ?? new Set<string>();
      names.add(name);
      this.saved.set(repo, names);
      // 保存は済んでいる。ここで失敗するのは一覧の取得や削除が想定外のエラーになった場合だけ。
      await this.prune(parent, names, name);
    });
  }
  private async prune(parent: string, names: Set<string>, written: string): Promise<void> {
    const saved = [];
    for (const entry of await entries(parent)) {
      if (!entry.isFile() || !isExplanationFile(entry.name)) {
        continue;
      }
      try {
        saved.push({ key: entry.name, lastUsed: (await lstat(join(parent, entry.name))).mtimeMs });
      } catch (error) {
        // 一覧の取得後に消えたファイルは数えず、索引からも外す。
        if (!isRecord(error) || error.code !== 'ENOENT') {
          throw error;
        }
        names.delete(entry.name);
      }
    }
    for (const entry of archiveEvictions(saved, EXPLANATION_MAX_COUNT, new Set([written]))) {
      await rm(join(parent, entry), { force: true });
      names.delete(entry);
    }
  }
}

// 保存先の階層がリンクならリンク先をたどらず失敗にする。まだなければ作らずに undefined を返す。
async function savedDirectory(root: string, repo: string): Promise<string | undefined> {
  const parent = join(root, repositoryId(repo));
  return (await existingDirectory(root)) && (await existingDirectory(parent)) ? parent : undefined;
}
function fileName(comparison: string): string {
  return `${hashId(comparison)}${FILE_SUFFIX}`;
}
function isExplanationFile(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/.test(name);
}
async function entries(parent: string): Promise<Dirent[]> {
  try {
    return await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
