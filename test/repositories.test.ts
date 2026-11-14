import type * as vscode from 'vscode';
import { workspaceFolder, repository, accessFor, temporaryDirectory } from './fixtures';
import { describe, expect, it, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryAccess, showRepositoryError } from '../src/ui/repositories';
import { GitClient, GitError, isNotRepository, runGit } from '../src/git/client';
import { window, Uri } from './vscodeMock';

describe('repositories', () => {
  it('Git管理外は通知せず、サブフォルダーは同じ正規ルートへまとめる', async () => {
    const { directory } = await repository();
    const nested = join(directory, 'nested');
    await mkdir(nested);
    const outside = await temporaryDirectory();
    const access = new RepositoryAccess((repo) => new GitClient(repo));
    const remote = {
      ...workspaceFolder(directory),
      uri: Uri.from({ scheme: 'vscode-remote', path: '/remote' }) as vscode.Uri,
    };
    await access.discover([...[directory, nested, outside].map(workspaceFolder), remote]);
    expect(access.all()).toEqual([directory]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    await access.discover([workspaceFolder(join(directory, 'absent'))]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    const bare = await temporaryDirectory();
    await runGit(bare, ['init', '--bare']);
    await access.discover([workspaceFolder(bare)]);
    expect(access.all()).toEqual([]);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('不正な取得先を拒否し、Git管理外判定をgit層に閉じる', async () => {
    const { directory } = await repository();
    const access = await accessFor(directory);
    expect(() => access.client('/outside')).toThrow('ワークスペース外のリポジトリは参照できません');
    expect(isNotRepository(new GitError([], 'fatal: not a git repository', 128))).toBe(true);
    expect(isNotRepository(new GitError([], 'Permission denied', 128))).toBe(false);
    vi.stubEnv('LC_ALL', 'ja_JP.UTF-8');
    const outside = await temporaryDirectory();
    const error: unknown = await runGit(outside, ['rev-parse', '--show-toplevel']).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isNotRepository(error)).toBe(true);
    if (!(error instanceof GitError)) {
      throw new Error('GitError expected');
    }
    expect(error.stderr).toContain('not a git repository');
  });

  it('到達確認が失敗しても元の取得エラーを一度だけ通知する', async () => {
    const { directory, git } = await repository();
    const access = await accessFor(directory, () => git);
    vi.spyOn(git, 'isReachable').mockRejectedValue(new Error('reachability failed'));
    await showRepositoryError(access, directory, 'a'.repeat(40), new Error('original failure'));
    expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith('VSReview: original failure');
  });

  it('古いdiscoverが新しい検出結果を上書きしない', async () => {
    const { directory } = await repository();
    const access = new RepositoryAccess((repo) => new GitClient(repo));
    const pending = access.discover([workspaceFolder(directory)]);
    await access.discover([]);
    await pending;
    expect(access.all()).toEqual([]);
  });
});
