import { isStatus, type Status, type ChangedFile, type FileSide } from './gitParsing';
import { isRecord, isRepoPath, isRevision } from './validation';

export interface StatusResource {
  repo: string;
  commit: string;
  side: FileSide;
  kind: 'file' | 'folder';
  path: string;
  status?: Status | undefined;
}
interface StatusUriParts {
  scheme: string;
  path: string;
  query: string;
}
const STATUS_DECORATIONS: Record<Status, { color: string; tooltip: string }> = {
  A: { color: 'gitDecoration.addedResourceForeground', tooltip: '追加' },
  M: { color: 'gitDecoration.modifiedResourceForeground', tooltip: '変更' },
  D: { color: 'gitDecoration.deletedResourceForeground', tooltip: '削除' },
  R: { color: 'gitDecoration.renamedResourceForeground', tooltip: 'リネーム' },
  C: { color: 'gitDecoration.addedResourceForeground', tooltip: 'コピー' },
  T: { color: 'gitDecoration.modifiedResourceForeground', tooltip: '種類変更' },
  U: { color: 'gitDecoration.conflictingResourceForeground', tooltip: '競合' },
};
export function statusDecoration(
  resource: StatusResource,
): { badge?: string; color: string; tooltip?: string } | undefined {
  if (!resource.status) {
    return undefined;
  }
  const { color, tooltip } = STATUS_DECORATIONS[resource.status];
  return resource.kind === 'folder' ? { color } : { badge: resource.status, color, tooltip };
}
export function statusUriParts(resource: StatusResource): StatusUriParts {
  const { path, ...metadata } = resource;
  return {
    scheme: 'vsreview-status',
    path: `/${path}`,
    query: new URLSearchParams({ ref: JSON.stringify(metadata) }).toString(),
  };
}
export function isStatusResource(value: unknown): value is Omit<StatusResource, 'path'> {
  return (
    isRecord(value) &&
    typeof value.repo === 'string' &&
    value.repo.length > 0 &&
    isRevision(value.commit) &&
    (value.side === 'old' || value.side === 'new') &&
    (value.kind === 'file' || value.kind === 'folder') &&
    (value.status === undefined || isStatus(value.status))
  );
}
export function statusLabel(path: string, status: Status | undefined): string {
  return status ? `${path} · ${STATUS_DECORATIONS[status].tooltip}` : path;
}
export function parseStatusUri(uri: StatusUriParts): StatusResource | undefined {
  if (uri.scheme !== 'vsreview-status' || !uri.path.startsWith('/')) {
    return undefined;
  }
  try {
    const metadata: unknown = JSON.parse(new URLSearchParams(uri.query).get('ref') ?? 'null');
    const path = uri.path.slice(1);
    return isStatusResource(metadata) && (isRepoPath(path) || (metadata.kind === 'folder' && path === ''))
      ? { ...metadata, path }
      : undefined;
  } catch {
    return undefined;
  }
}
export function folderStatus(path: string, changes: ReadonlyMap<string, ChangedFile>): Status | undefined {
  const statuses = new Set<Status>();
  for (const [file, change] of changes) {
    if (!path || file.startsWith(`${path}/`)) {
      statuses.add(change.status);
    }
  }
  return statuses.size > 1 ? 'M' : statuses.values().next().value;
}
