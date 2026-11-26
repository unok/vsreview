import type * as vscode from 'vscode';
import { repositoryId } from '../git/repositoryId';
import { RepositoryPermissions } from './repositoryPermissions';
type ArchivePullRequest = { number: number; head: string };
const PERMISSION_PREFIX = 'vsreview.archivePermission.';
export function archivePermissionKey(repo: string, pullRequest?: ArchivePullRequest): string {
  return `${PERMISSION_PREFIX}${repositoryId(repo)}${pullRequest === undefined ? '' : `.pr.${pullRequest.number}.${pullRequest.head}`}`;
}
export class RevisionArchivePermissions extends RepositoryPermissions<[pullRequest?: ArchivePullRequest]> {
  constructor(state: vscode.Memento) {
    super(state, {
      prefix: PERMISSION_PREFIX,
      key: archivePermissionKey,
      message: (repo, pullRequest) =>
        `${repo}${pullRequest === undefined ? '' : ` の外部 PR #${pullRequest.number} (${pullRequest.head})`} の過去のソースを展開します。展開したファイルを開くと、他の拡張がそのリビジョンの設定ファイルを読み込んでコードを実行する可能性があります`,
      allow: '許可',
      deny: '拒否',
    });
  }
}
