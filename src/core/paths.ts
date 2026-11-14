import { resolve, relative, isAbsolute, sep } from 'node:path';
import { isRepoPath } from './validation';
export const OUTSIDE_REPOSITORY = 'リポジトリ外のパスは開けません';
export function repoRelativePath(repo: string, path: string): string {
  return relative(repo, path).split(sep).join('/');
}
export function repoFile(repo: string, path: string): string {
  if (!isRepoPath(path)) {
    throw new Error(OUTSIDE_REPOSITORY);
  }
  const result = resolve(repo, path);
  const rel = relative(repo, result);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(OUTSIDE_REPOSITORY);
  }
  return result;
}
export function isWithin(repo: string, path: string): boolean {
  const rel = relative(repo, path);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
