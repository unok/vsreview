import * as vscode from 'vscode';
import { activate as activateReview } from '../src/extension';
import { GitClient } from '../src/git/client';
import { explanationPermissionKey } from '../src/ui/explanationPermissions';
import { archivePermissionKey } from '../src/ui/revisionArchivePermissions';

// 確認ダイアログが自動 E2E を止めないよう、テスト対象のリポジトリだけ事前許可する。
export async function activate(context: vscode.ExtensionContext) {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const git = await GitClient.resolve(folder.uri.fsPath);
    await context.workspaceState.update(archivePermissionKey(git.root), true);
    await context.workspaceState.update(explanationPermissionKey(git.root, 'claude'), true);
    const pullRequest = JSON.parse(process.env.VSREVIEW_E2E_PULL_REQUEST ?? 'null') as {
      number: number;
      headRefOid: string;
    } | null;
    if (pullRequest) {
      await context.workspaceState.update(
        archivePermissionKey(git.root, { number: pullRequest.number, head: pullRequest.headRefOid }),
        true,
      );
    }
  }
  return await activateReview(context);
}
