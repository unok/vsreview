import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitClient, runGit } from '../src/git/client';
export { commitAll, gitAsAuthor, TEST_AUTHOR, TEST_EMAIL } from '../fixtures/gitFixtures.mts';
export async function createRepository(): Promise<{ directory: string; git: GitClient; dispose: () => Promise<void> }> {
  const directory = await createTemporaryDirectory();
  await runGit(directory, ['init', '-b', 'main']);
  return {
    directory,
    git: await GitClient.resolve(directory),
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

export function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vsreview-test-'));
}
