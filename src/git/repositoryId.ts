import { createHash } from 'node:crypto';
export function repositoryId(repo: string): string {
  return createHash('sha256').update(repo).digest('hex');
}
