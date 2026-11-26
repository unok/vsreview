import { isUtf8 } from 'node:buffer';
import { repositoryId } from './repositoryId';
import { type TreeRecord, parseTreeRecordMetadata, GIT_REGULAR_MODES } from '../core/gitParsing';
import {
  directory,
  isCaseInsensitiveFilesystem,
  isNormalizationInsensitiveFilesystem,
  isUnavailablePathError,
} from './paths';
import { randomUUID } from 'node:crypto';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  utimes,
  realpath,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PromiseCache, SerialQueue, forEachConcurrent } from '../core/collections';
import {
  archivePath,
  archiveLinkPaths,
  archiveExcludedPath,
  archiveEvictions,
  archiveLinkPatternName,
  archiveDirectories,
  ArchiveBudget,
  archiveBareRoots,
  archivePathCollisions,
} from '../core/revisionArchive';
import { repoFile, isWithin } from '../core/paths';
import { isRecord, isRevision } from '../core/validation';
import { assertRevision, type GitClient } from './client';

const TAB_BYTE = 9;
export const LINK_PATH_CONCURRENCY = 16;

class InvalidArchiveMetadata extends Error {}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
      return false;
    }
    throw error;
  }
}
export class RevisionArchiveStore {
  private readonly pending = new PromiseCache<string>();
  private readonly queue = new SerialQueue();
  private readonly root: string;
  constructor(
    storage: string,
    private readonly warn: (message: string) => void = () => {},
    private readonly caseInsensitive = isCaseInsensitiveFilesystem,
    private readonly now: () => number = () => Date.now(),
    private readonly normalizationInsensitive = isNormalizationInsensitiveFilesystem,
    private readonly platform = process.platform,
    private readonly linkSourceIsDirectory = async (path: string): Promise<boolean> =>
      (await exists(path)) && (await stat(path)).isDirectory(),
  ) {
    this.root = join(storage, 'revisionArchives');
  }
  initialize(): Promise<void> {
    return this.queue.run(async () => {
      for (const parent of await this.repositories()) {
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          const markedRevision = entry.name.endsWith('.complete')
            ? entry.name.slice(0, -'.complete'.length)
            : undefined;
          if (markedRevision && isRevision(markedRevision) && !(await exists(join(parent, markedRevision)))) {
            await this.remove(join(parent, markedRevision));
          } else if (
            entry.name.startsWith('.tmp-') ||
            (isRevision(entry.name) && !(await exists(join(parent, `${entry.name}.complete`))))
          ) {
            await rm(join(parent, entry.name), { recursive: true, force: true });
          }
        }
      }
    });
  }
  async get(git: GitClient, rev: string, links: readonly string[]): Promise<string> {
    assertRevision(rev);
    const key = JSON.stringify([git.root, rev]);
    return this.pending.get(key, () =>
      this.queue.run(async () => {
        try {
          return await this.extract(git, rev, links);
        } finally {
          this.pending.delete(key);
        }
      }),
    );
  }
  private async extract(git: GitClient, rev: string, links: readonly string[]): Promise<string> {
    await directory(this.root);
    const parent = join(this.root, repositoryId(git.root));
    await directory(parent);
    const destination = join(parent, rev);
    const marker = `${destination}.complete`;
    if (await this.valid(destination, git.root)) {
      const now = new Date(this.now());
      await utimes(marker, now, now);
      return destination;
    }
    await this.remove(destination);
    const temporary = join(parent, `.tmp-${randomUUID()}`);
    await mkdir(temporary);
    try {
      const reasons = new Set<string>();
      const warnOnce = (message: string): void => {
        if (!reasons.has(message)) {
          reasons.add(message);
          this.warn(message);
        }
      };
      const budget = new ArchiveBudget();
      const entries = await this.plan(git, rev, budget, warnOnce);
      const paths = entries.map(({ path }) => path);
      const bareRoots = archiveBareRoots(paths);
      const caseInsensitive = await this.caseInsensitive(temporary);
      const normalizationInsensitive = await this.normalizationInsensitive(temporary);
      const collisions = new Set(archivePathCollisions(paths, caseInsensitive, normalizationInsensitive));
      const excluded = archiveExcludedPath([...collisions, ...bareRoots]);
      if (collisions.size) {
        warnOnce('大文字小文字または Unicode 正規化で衝突するパスを除外してリビジョンを展開しました');
      }
      if (bareRoots.length) {
        warnOnce('ベアリポジトリの構成を除外してリビジョンを展開しました');
      }
      await this.writeFiles(git, rev, temporary, budget, entries, excluded, warnOnce);
      // 中身を公開せず、Files ビューから参照する履歴のディレクトリ名だけ保つ。
      for (const path of bareRoots) {
        if (path && !collisions.has(path)) {
          await directory(repoFile(temporary, path));
        }
      }
      const linked = await this.linkPaths(
        git,
        temporary,
        paths,
        links,
        excluded,
        caseInsensitive,
        normalizationInsensitive,
        warnOnce,
      );
      // 完成した内容だけを公開し、完了情報は排他的に作る。中断時は次回 valid で再展開する。
      await rename(temporary, destination);
      await writeFile(marker, JSON.stringify({ repo: git.root, links: linked }), { flag: 'wx' });
      const used = new Date(this.now());
      await utimes(marker, used, used);
      return destination;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private async linkPaths(
    git: GitClient,
    temporary: string,
    paths: readonly string[],
    links: readonly string[],
    excluded: (path: string) => boolean,
    caseInsensitive: boolean,
    normalizationInsensitive: boolean,
    warnOnce: (message: string) => void,
  ): Promise<string[]> {
    const resolvedLinks = await this.resolveLinkPaths(
      git,
      temporary,
      paths,
      links,
      caseInsensitive,
      normalizationInsensitive,
      warnOnce,
    );
    const linked: string[] = [];
    const linkCollisions = new Set(
      archivePathCollisions([...paths, ...resolvedLinks], caseInsensitive, normalizationInsensitive),
    );
    for (const path of resolvedLinks) {
      try {
        const source = repoFile(git.root, path);
        const target = repoFile(temporary, path);
        if (excluded(path)) {
          warnOnce('除外対象と衝突するリンクを除いてリビジョンを展開しました');
          continue;
        }
        if (linkCollisions.has(path) || (await exists(target))) {
          warnOnce('履歴のパスと重複するリンクを除いてリビジョンを展開しました');
          continue;
        }
        if (await this.blockedParent(temporary, target)) {
          warnOnce('親がファイルのリンクを除いてリビジョンを展開しました');
          continue;
        }
        if ((await exists(source)) && !(await exists(target))) {
          const resolvedSource = await realpath(source);
          if (!isWithin(await realpath(git.root), resolvedSource)) {
            warnOnce('リポジトリ外を指すリンクを除いてリビジョンを展開しました');
            continue;
          }
          await directory(dirname(target));
          const sourceStat = await stat(source);
          // 検証した実体を絶対パスで固定し、Windows のディレクトリは管理者権限が不要な junction にする。
          await symlink(resolvedSource, target, sourceStat.isDirectory() ? 'junction' : 'file');
          linked.push(path);
        }
      } catch (error) {
        this.handleLinkFailure(error, warnOnce);
      }
    }
    return linked;
  }
  private handleLinkFailure(error: unknown, warnOnce: (message: string) => void): void {
    if (isUnavailablePathError(error)) {
      warnOnce('利用できないリンクを除外してリビジョンを展開しました');
    } else {
      throw error;
    }
  }
  private async resolveLinkPaths(
    git: GitClient,
    temporary: string,
    paths: readonly string[],
    links: readonly string[],
    caseInsensitive: boolean,
    normalizationInsensitive: boolean,
    warnOnce: (message: string) => void,
  ): Promise<string[]> {
    const fixed = links.filter((path) => archiveLinkPatternName(path) === undefined);
    const names = new Set(links.flatMap((path) => archiveLinkPatternName(path) ?? []));
    if (!names.size) {
      return fixed;
    }
    const presentFixed: string[] = [];
    for (const path of fixed) {
      try {
        if (await exists(repoFile(git.root, path))) {
          presentFixed.push(path);
        }
      } catch (error) {
        this.handleLinkFailure(error, warnOnce);
      }
    }
    const fixedParents = archiveDirectories(presentFixed);
    const pending = [...archiveDirectories(paths)].flatMap((parent) =>
      [...names].map((name) => (parent ? `${parent}/${name}` : name)).filter((path) => !fixedParents.has(path)),
    );
    const available = new Set<string>();
    await forEachConcurrent(pending, LINK_PATH_CONCURRENCY, async (path) => {
      try {
        archivePath(path, this.platform);
        const source = repoFile(git.root, path);
        if (!(await this.linkSourceIsDirectory(source))) {
          return;
        }
        // 完了情報で未解決パターンと区別できない名前は保存せず、再展開のループを防ぐ。
        if (archiveLinkPatternName(path) !== undefined) {
          warnOnce('パターンと区別できないリンクを除いてリビジョンを展開しました');
          return;
        }
        const targetParent = dirname(repoFile(temporary, path));
        // 親はリンクをたどらず展開済みの実ディレクトリに限り、元の依存ディレクトリはリンク先も許す。
        if ((await exists(targetParent)) && (await lstat(targetParent)).isDirectory()) {
          available.add(path);
        }
      } catch (error) {
        this.handleLinkFailure(error, warnOnce);
      }
    });
    // 現在追跡しているソースをリンクすると、履歴にない作業ツリーの内容をレビューへ混ぜてしまう。
    const tracked = await git.trackedPaths([...available], caseInsensitive, normalizationInsensitive);
    const candidates = new Set([
      ...presentFixed,
      ...pending.filter((path) => available.has(path) && !tracked.has(path)),
    ]);
    return [...candidates].filter((path) => {
      if (fixed.includes(path)) {
        return true;
      }
      for (const parent of archiveDirectories([path])) {
        if (candidates.has(parent)) {
          return false;
        }
      }
      return true;
    });
  }
  private async writeFiles(
    git: GitClient,
    rev: string,
    temporary: string,
    budget: ArchiveBudget,
    entries: readonly TreeRecord[],
    excluded: (path: string) => boolean,
    warnOnce: (message: string) => void,
  ): Promise<void> {
    await git.expandRevision(
      rev,
      async (entry, body) => {
        const name = archivePath(entry.path, this.platform);
        budget.addBytes(entry.size);
        const path = repoFile(temporary, name);
        const file = await this.createFile(path, entry.executable, warnOnce);
        if (!file) {
          await body(() => Promise.resolve());
          return;
        }
        try {
          await body(async (chunk) => {
            await file.writeFile(chunk);
          });
          // 作成時の umask が落とした権限は戻さず、書き込みビットだけを落とす。
          await file.chmod((await file.stat()).mode & ~0o222);
        } finally {
          await file.close();
        }
      },
      (path) => !excluded(path),
      entries,
      () => warnOnce('欠けた blob を書き出せなかったため除外してリビジョンを展開しました'),
    );
  }
  private async createFile(
    path: string,
    executable: boolean,
    warn: (message: string) => void,
  ): Promise<FileHandle | undefined> {
    try {
      await directory(dirname(path));
      return await open(path, 'wx', executable ? 0o777 : 0o666);
    } catch (error) {
      if (isUnavailablePathError(error)) {
        warn('保存先で利用できないパスを除外してリビジョンを展開しました');
        return undefined;
      }
      throw error;
    }
  }
  private async plan(
    git: GitClient,
    rev: string,
    budget: ArchiveBudget,
    warn: (message: string) => void,
  ): Promise<TreeRecord[]> {
    const entries: TreeRecord[] = [];
    await git.revisionFiles(rev, (record) => {
      // 除外するエントリーも数え、一覧の収集だけで上限を使い切る入力を制限する。
      budget.addFile(0);
      budget.addPath(record.length - Math.max(0, record.indexOf(TAB_BYTE) + 1));
      if (!isUtf8(record)) {
        warn('UTF-8 として不正なパスを除外してリビジョンを展開しました');
        return;
      }
      // Git のパス形式と保存先の制約を分け、Windows で書けない名前は個別に除く。
      const entry = parseTreeRecordMetadata(record.toString('utf8'));
      if (!GIT_REGULAR_MODES.includes(entry.mode)) {
        return;
      }
      try {
        archivePath(entry.path, this.platform);
        entries.push(entry);
      } catch {
        warn('安全でないパスを除外してリビジョンを展開しました');
      }
    });
    return entries;
  }
  private async blockedParent(root: string, path: string): Promise<boolean> {
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
      if (await exists(parent)) {
        return !(await lstat(parent)).isDirectory();
      }
    }
    return false;
  }
  rootFor(repo: string, rev: string): string {
    assertRevision(rev);
    return join(this.root, repositoryId(repo), rev);
  }
  async valid(root: string, repo: string): Promise<boolean> {
    try {
      return (await lstat(root)).isDirectory() && (await this.metadata(root)).repo === repo;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (isRecord(error) && error.code === 'ENOENT') ||
        error instanceof InvalidArchiveMetadata
      ) {
        return false;
      }
      throw error;
    }
  }
  private async metadata(root: string): Promise<{ repo: string; links: string[] }> {
    const value: unknown = JSON.parse(await readFile(`${root}.complete`, 'utf8'));
    if (!isRecord(value) || typeof value.repo !== 'string' || !Array.isArray(value.links)) {
      throw new InvalidArchiveMetadata('展開の完了情報が不正です');
    }
    if (value.links.some((path) => typeof path === 'string' && archiveLinkPatternName(path) !== undefined)) {
      throw new InvalidArchiveMetadata('展開の完了情報に未解決のパターンがあります');
    }
    try {
      return { repo: value.repo, links: archiveLinkPaths(value.links) };
    } catch {
      throw new InvalidArchiveMetadata('展開の完了情報が不正です');
    }
  }
  async links(root: string): Promise<string[]> {
    return (await this.metadata(root)).links;
  }
  private async repositories(): Promise<string[]> {
    if (!(await exists(this.root))) {
      return [];
    }
    return (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => join(this.root, entry.name));
  }
  prune(maxCount: number, pinned: ReadonlySet<string>, leased: () => boolean = () => false): Promise<string[]> {
    return this.queue.run(async () => {
      if (leased()) {
        return [];
      }
      const removed: string[] = [];
      for (const parent of await this.repositories()) {
        const entries = [];
        for (const entry of await readdir(parent)) {
          if (isRevision(entry) && (await exists(join(parent, `${entry}.complete`)))) {
            // 開いていたリビジョンを、タブを閉じた直後の LRU で最古として消さない。
            if (pinned.has(join(parent, entry))) {
              const now = new Date(this.now());
              await utimes(join(parent, `${entry}.complete`), now, now);
            }
            entries.push({
              key: join(parent, entry),
              lastUsed: (await lstat(join(parent, `${entry}.complete`))).mtimeMs,
            });
          }
        }
        for (const path of archiveEvictions(entries, maxCount, pinned)) {
          await this.remove(path);
          removed.push(path);
        }
      }
      return removed;
    });
  }
  private async remove(path: string): Promise<void> {
    // 中断しても完成済みと誤認されないよう、内容より先に完了情報を外す。
    await rm(`${path}.complete`, { force: true });
    await rm(path, { recursive: true, force: true });
  }
  clear(): Promise<void> {
    return this.queue.run(async () => {
      for (const parent of await this.repositories()) {
        for (const entry of await readdir(parent)) {
          const rev = entry.endsWith('.complete') ? entry.slice(0, -'.complete'.length) : entry;
          if (isRevision(rev)) {
            await this.remove(join(parent, rev));
          }
        }
      }
    });
  }
}
