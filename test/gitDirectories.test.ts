import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { GitClient, runGit } from '../src/git/client';
import { repository, temporaryDirectory } from './fixtures';
import { commitAll } from './gitFixtures';

describe('gitDirectories', () => {
  it('通常リポジトリ・linked worktree・detached HEADの管理先を解決する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'one');
    await commitAll(directory, 'one');
    const dirs = await git.directories();
    expect(dirs).toEqual({ gitDir: join(directory, '.git'), commonDir: join(directory, '.git') });
    const worktree = join(await temporaryDirectory(), 'worktree 日本 space');
    await runGit(directory, ['worktree', 'add', '--detach', worktree, 'HEAD']);
    try {
      const linked = await GitClient.resolve(worktree);
      const linkedDirs = await linked.directories();
      expect(linkedDirs.commonDir).toBe(dirs.commonDir);
      expect(linkedDirs.gitDir.startsWith(join(dirs.commonDir, 'worktrees') + '/')).toBe(true);
      expect(await linked.head()).toBe(await git.head());
      expect(await linked.branch()).toEqual({ head: await git.head() });
    } finally {
      await runGit(directory, ['worktree', 'remove', '--force', worktree]);
    }
  });
  it('未作成リポジトリでも解決し、管理外ならGitエラーを返す', async () => {
    const { git, directory } = await repository();
    expect((await git.directories()).gitDir).toBe(join(directory, '.git'));
    const missing = new GitClient(await temporaryDirectory());
    await expect(missing.directories()).rejects.toThrow('not a git repository');
  });
});
