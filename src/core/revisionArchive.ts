import { compareNames } from './collections';
import { isRepoPath } from './validation';

export const ARCHIVE_MAX_COUNT_DEFAULT = 10;
export const ARCHIVE_MAX_COUNT_MINIMUM = 2;
export const ARCHIVE_MAX_COUNT_MAXIMUM = 50;
export const ARCHIVE_LINK_PATHS_DEFAULT = ['**/node_modules'];
export const ARCHIVE_MAX_FILES = 200_000;
export const ARCHIVE_MAX_PATH_BYTES = 32 * 1024 * 1024;
export const ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export function archivePath(value: string, platform = process.platform): string {
  const segments = value.split('/');
  if (
    !isRepoPath(value, platform) ||
    segments.some((part) => {
      // NTFS と HFS の別名も拒否し、設定ファイルとして解釈される入口を作らない。
      const normalized = archiveComponent(part);
      return (
        normalized === '.git' ||
        /^git~[1-9][0-9]*$/.test(normalized) ||
        (platform === 'win32' &&
          (/[<>:"|?*\\\p{Cc}]/u.test(part) ||
            /[. ]$/.test(part) ||
            /~[1-9][0-9]*(?:\.|$)/i.test(part) ||
            /^(con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part.replace(/[. ]+$/, ''))))
      );
    })
  ) {
    throw new Error(`展開先のパスが不正です: ${value}`);
  }
  return value;
}
export function archiveLinkPatternName(path: string): string | undefined {
  return /^\*\*\/([^/*]+)$/.exec(path)?.[1];
}
export function archiveDirectories(paths: readonly string[]): Set<string> {
  const directories = new Set(['']);
  for (const path of paths) {
    for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
      directories.add(path.slice(0, end));
    }
  }
  return directories;
}
export function archiveLinkPaths(value: unknown, platform = process.platform): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error('revisionArchive.linkPaths はリポジトリ相対パスまたは **/名前 パターンの配列が必要です');
  }
  const paths = value.map((path) => {
    archivePath(archiveLinkPatternName(path) ?? path, platform);
    return path;
  });
  const root = pathTrie({ terminal: false });
  for (const path of paths) {
    if (archiveLinkPatternName(path) !== undefined) {
      continue;
    }
    let node = root;
    for (const part of path.split('/')) {
      if (node.value.terminal) {
        throw new Error('revisionArchive.linkPaths のパスが重複しています');
      }
      let child = node.children.get(part);
      if (!child) {
        child = pathTrie({ terminal: false });
        node.children.set(part, child);
      }
      node = child;
    }
    if (node.value.terminal || node.children.size) {
      throw new Error('revisionArchive.linkPaths のパスが重複しています');
    }
    node.value.terminal = true;
  }
  return paths;
}
export function archiveEvictions(
  entries: readonly { key: string; lastUsed: number }[],
  maxCount: number,
  pinned: ReadonlySet<string>,
): string[] {
  return entries
    .filter(({ key }) => !pinned.has(key))
    .sort((a, b) => a.lastUsed - b.lastUsed || compareNames(a.key, b.key))
    .slice(0, Math.max(0, entries.length - maxCount))
    .map(({ key }) => key);
}

export class ArchiveBudget {
  private count = 0;
  private bytes = 0;
  private pathBytes = 0;
  addPath(bytes: number): void {
    this.pathBytes += bytes;
    if (this.pathBytes > ARCHIVE_MAX_PATH_BYTES) {
      throw new Error(`展開のパス名の総バイト数が上限 ${ARCHIVE_MAX_PATH_BYTES} を超えました`);
    }
  }
  addFile(size: number): void {
    if (++this.count > ARCHIVE_MAX_FILES) {
      throw new Error(`展開のファイル数が上限 ${ARCHIVE_MAX_FILES} 件を超えました`);
    }
    this.addBytes(size);
  }
  addBytes(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('blob のサイズが不正です');
    }
    this.bytes += size;
    if (this.bytes > ARCHIVE_MAX_BYTES) {
      throw new Error(`展開の総バイト数が上限 ${ARCHIVE_MAX_BYTES} を超えました`);
    }
  }
}

export function archiveComponent(part: string): string {
  return part
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
}
interface PathTrie<T> {
  children: Map<string, PathTrie<T>>;
  value: T;
}
function pathTrie<T>(value: T): PathTrie<T> {
  return { children: new Map(), value };
}
export function archiveBareRoots(paths: readonly string[]): string[] {
  const root = pathTrie(new Set<string>());
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const component = archiveComponent(parts[i]!);
      const file = i === parts.length - 1;
      if (
        (file && (component === 'head' || component === 'commondir')) ||
        component === 'objects' ||
        component === 'refs'
      ) {
        node.value.add(component);
      }
      let child = node.children.get(component);
      if (!child) {
        child = pathTrie(new Set<string>());
        node.children.set(component, child);
      }
      node = child;
    }
  }
  const roots = new Set<string>();
  for (const path of paths) {
    let node = root;
    let offset = 0;
    for (const part of path.split('/')) {
      if (
        node.value.has('head') &&
        (node.value.has('commondir') || (node.value.has('objects') && node.value.has('refs')))
      ) {
        // 上位のベア構成で下位も除外するので、各パスの接頭辞は一度だけ作る。
        roots.add(path.slice(0, Math.max(0, offset - 1)));
        break;
      }
      node = node.children.get(archiveComponent(part))!;
      offset += part.length + 1;
    }
  }
  return [...roots];
}
export function archivePathKey(path: string, caseInsensitive: boolean, normalizationInsensitive = false): string {
  const normalized = normalizationInsensitive ? path.normalize('NFC') : path;
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}
export function archivePathCollisions(
  paths: readonly string[],
  caseInsensitive: boolean,
  normalizationInsensitive = false,
): string[] {
  const root = pathTrie({ spelling: '', file: false, conflict: false });
  const key = (part: string): string => archivePathKey(part, caseInsensitive, normalizationInsensitive);
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const spelling = parts[i]!;
      const normalized = key(spelling);
      const file = i === parts.length - 1;
      let child = node.children.get(normalized);
      if (!child) {
        child = pathTrie({ spelling, file, conflict: false });
        node.children.set(normalized, child);
      } else if (child.value.spelling !== spelling || child.value.file !== file) {
        child.value.conflict = true;
      }
      node = child;
    }
  }
  return paths.filter((path) => {
    let node = root;
    for (const part of path.split('/')) {
      node = node.children.get(key(part))!;
      if (node.value.conflict) {
        return true;
      }
    }
    return false;
  });
}
export function archiveExcludedPath(roots: readonly string[]): (path: string) => boolean {
  const root = pathTrie({ excluded: false });
  for (const path of roots) {
    let node = root;
    for (const part of path ? path.split('/') : []) {
      let child = node.children.get(part);
      if (!child) {
        child = pathTrie({ excluded: false });
        node.children.set(part, child);
      }
      node = child;
    }
    node.value.excluded = true;
  }
  return (path) => {
    let node: PathTrie<{ excluded: boolean }> | undefined = root;
    for (const part of path.split('/')) {
      if (node.value.excluded) {
        return true;
      }
      node = node.children.get(part);
      if (!node) {
        return false;
      }
    }
    return node.value.excluded;
  };
}
