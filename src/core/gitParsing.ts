import { isRecord, hasStrings, isRevision, isRepoPath, isOptionalRepoPath } from './validation';
const STATUSES = ['A', 'M', 'D', 'R', 'C', 'T', 'U'] as const;
export type Status = (typeof STATUSES)[number];
export function isStatus(value: unknown): value is Status {
  return STATUSES.some((status) => status === value);
}
const LOG_FIELDS = ['%H', '%P', '%s', '%an', '%aI', '%B'] as const;
export const LOG_FORMAT = LOG_FIELDS.join('%x00');
export interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  message: string;
}
export interface ChangedFile {
  status: Status;
  path: string;
  oldPath?: string;
}
export function parseLog(output: string): Commit[] {
  if (!output) {
    return [];
  }
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  if (fields.length % LOG_FIELDS.length !== 0) {
    throw new Error('git log の出力が不完全です');
  }
  const commits: Commit[] = [];
  for (let i = 0; i < fields.length; i += LOG_FIELDS.length) {
    const [hash = '', parents = '', subject = '', author = '', date = '', message = ''] = fields.slice(
      i,
      i + LOG_FIELDS.length,
    );
    commits.push({ hash, parents: parents.split(' ').filter(Boolean), subject, author, date, message });
  }
  return commits;
}
export function parseNameStatus(output: string): ChangedFile[] {
  if (!output) {
    return [];
  }
  const fields = output.split('\0');
  if (fields.pop() !== '') {
    throw new Error('git diff の出力が不完全です');
  }
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index++]?.charAt(0);
    const first = fields[index++];
    if (!isStatus(status) || !first) {
      throw new Error('変更ファイルの形式が不正です');
    }
    if (status === 'R' || status === 'C') {
      const path = fields[index++];
      if (!path) {
        throw new Error('リネーム先がありません');
      }
      files.push({ status, path, oldPath: first });
    } else {
      files.push({ status, path: first });
    }
  }
  return files;
}

export function isCommit(value: unknown): value is Commit {
  return (
    isRecord(value) &&
    hasStrings(value, ['subject', 'author', 'date', 'message']) &&
    isRevision(value.hash) &&
    Array.isArray(value.parents) &&
    value.parents.every(isRevision)
  );
}
export function isChangedFile(value: unknown): value is ChangedFile {
  return isRecord(value) && isRepoPath(value.path) && isStatus(value.status) && isOptionalRepoPath(value.oldPath);
}

export const GIT_TREE_MODE = '040000';
export const GIT_REGULAR_FILE_MODE = '100644';
export const GIT_EXECUTABLE_MODE = '100755';
export const GIT_SYMLINK_MODE = '120000';
export const GIT_GITLINK_MODE = '160000';
export const GIT_REGULAR_MODES: readonly string[] = [GIT_REGULAR_FILE_MODE, GIT_EXECUTABLE_MODE];
export interface TreeEntry {
  kind: 'folder' | 'file' | 'gitlink';
  path: string;
}

export function parseTree(output: string): TreeEntry[] {
  if (!output) {
    return [];
  }
  const records = output.split('\0');
  if (records.pop() !== '') {
    throw new Error('git ls-tree の出力が不完全です');
  }
  return records.map((record) => {
    const { kind, path } = parseTreeRecord(record);
    return { kind, path };
  });
}
export interface TreeRecord extends TreeEntry {
  mode: string;
  hash: string;
}
export function parseTreeRecord(record: string, platform = process.platform): TreeRecord {
  const entry = parseTreeRecordMetadata(record);
  if (!isRepoPath(entry.path, platform)) {
    throw new Error('git ls-tree の形式が不正です');
  }
  return entry;
}
export function parseTreeRecordMetadata(record: string): TreeRecord {
  const tab = record.indexOf('\t');
  const [mode, type, hash, extra] = record.slice(0, tab).split(' ');
  const path = record.slice(tab + 1);
  const kind =
    mode === GIT_TREE_MODE && type === 'tree'
      ? 'folder'
      : mode === GIT_GITLINK_MODE && type === 'commit'
        ? 'gitlink'
        : [...GIT_REGULAR_MODES, GIT_SYMLINK_MODE].includes(mode ?? '') && type === 'blob'
          ? 'file'
          : undefined;
  if (tab < 0 || !kind || extra !== undefined || !isRevision(hash)) {
    throw new Error('git ls-tree の形式が不正です');
  }
  return { kind, path, mode: mode!, hash };
}

export type FileSide = 'old' | 'new';
export function fileSide(file: ChangedFile, side: FileSide): { path: string; empty: boolean } {
  return side === 'old'
    ? { path: file.oldPath ?? file.path, empty: file.status === 'A' }
    : { path: file.path, empty: file.status === 'D' };
}
