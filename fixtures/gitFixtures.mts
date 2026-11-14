import { execFile } from 'node:child_process';
import { gitExecutable } from '../src/git/executable.mts';
import { promisify } from 'node:util';
export const TEST_AUTHOR = 'テスト作者';
export const TEST_EMAIL = 'test@example.invalid';
const execute = promisify(execFile);
export async function commitAll(repo: string, message: string, options: { amend?: boolean } = {}): Promise<void> {
  const args = ['-C', repo];
  await execute(gitExecutable(), [...args, 'add', '.']);
  await gitAsAuthor(repo, ['commit', ...(options.amend ? ['--amend'] : []), '-m', message]);
}
export async function gitAsAuthor(repo: string, args: readonly string[]): Promise<void> {
  await execute(gitExecutable(), [
    '-C',
    repo,
    '-c',
    `user.name=${TEST_AUTHOR}`,
    '-c',
    `user.email=${TEST_EMAIL}`,
    ...args,
  ]);
}
