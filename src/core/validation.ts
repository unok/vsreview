export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}
export function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}
export function isOptionalRepoPath(value: unknown): boolean {
  return value === undefined || isRepoPath(value);
}
export function isRepoPath(value: unknown, platform = process.platform): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/\0/.test(value) &&
    (platform !== 'win32' || (!value.includes('\\') && !/^[A-Za-z]:/.test(value))) &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '..' || part === '.' || !part)
  );
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isRefName(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !/[\s\p{Cc}~^:?*+[\\]/u.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    ref.split('/').every((part) => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
