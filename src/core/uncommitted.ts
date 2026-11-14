import type { ChangedFile, Commit } from './gitParsing';
import { isRecord, isRevision } from './validation';

export type UncommittedKind = 'staged' | 'unstaged';
export interface UncommittedSnapshot {
  kind: UncommittedKind;
  head?: string;
  createdAt: string;
}
export interface UncommittedChange {
  kind: UncommittedKind;
  commit: Commit;
  parent: string;
  files: ChangedFile[];
}
export interface UncommittedChanges {
  head?: string;
  createdAt: string;
  staged: UncommittedChange;
  unstaged: UncommittedChange;
}
export function isUncommittedSnapshot(value: unknown): value is UncommittedSnapshot {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    (value.kind === 'staged' || value.kind === 'unstaged') &&
    (value.head === undefined || isRevision(value.head)) &&
    typeof value.createdAt === 'string'
  );
}
export function isUncommittedChanged(
  saved: { commit: string; uncommitted: UncommittedSnapshot },
  current: UncommittedChanges,
): boolean {
  return saved.commit !== current[saved.uncommitted.kind].commit.hash;
}
