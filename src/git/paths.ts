import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord } from '../core/validation';
import { lstat, realpath, writeFile, rm, readFile } from 'node:fs/promises';
import { isWithin } from '../core/paths';

export async function isRealFileWithin(root: string, path: string): Promise<boolean> {
  return isWithin(root, path) && isWithin(await realpath(root), await realpath(path));
}

export function isUnreachablePathError(error: unknown): boolean {
  return isRecord(error) && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(String(error.code));
}

export function isUnavailablePathError(error: unknown): boolean {
  return isUnreachablePathError(error) || (isRecord(error) && ['EINVAL', 'ENAMETOOLONG'].includes(String(error.code)));
}

export async function isRegularFileWithin(root: string, path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile() && (await isRealFileWithin(root, path));
  } catch (error) {
    if (isUnreachablePathError(error)) {
      return false;
    }
    throw error;
  }
}

async function filesystemAliases(directory: string, spelling: string, alias: string): Promise<boolean> {
  const path = join(directory, spelling);
  await writeFile(path, '', { flag: 'wx' });
  try {
    try {
      await lstat(join(directory, alias));
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(path);
  }
}
export async function isCaseInsensitiveFilesystem(directory: string): Promise<boolean> {
  const name = `.case-probe-${randomUUID()}`;
  return filesystemAliases(directory, name, name.toUpperCase());
}
export function isNormalizationInsensitiveFilesystem(directory: string): Promise<boolean> {
  const name = `.normalization-probe-${randomUUID()}-é`;
  return filesystemAliases(directory, name, name.normalize('NFD'));
}

export function decodeText(content: Buffer): string {
  return content.toString('utf8').replace(/^\uFEFF/, '');
}

export async function matchesFileContent(root: string, path: string, expected: string): Promise<boolean> {
  try {
    return (await isRegularFileWithin(root, path)) && decodeText(await readFile(path)) === expected;
  } catch (error) {
    if (isUnreachablePathError(error)) {
      return false;
    }
    throw error;
  }
}
