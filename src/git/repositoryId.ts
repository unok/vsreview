import { createHash } from 'node:crypto';
export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function repositoryId(repo: string): string {
  return hashId(repo);
}
