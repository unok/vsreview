import type * as vscode from 'vscode';
import type { ExplanationAgent } from '../core/explanations';
import { repositoryId } from '../git/repositoryId';
import { RepositoryPermissions } from './repositoryPermissions';
const PERMISSION_PREFIX = 'vsreview.explanationPermission.';
// 送り先の事業者が変わるので、エージェントごとに確認する。
export function explanationPermissionKey(repo: string, agent: ExplanationAgent): string {
  return `${PERMISSION_PREFIX}${repositoryId(repo)}.${agent}`;
}
export class ExplanationPermissions extends RepositoryPermissions<[agent: ExplanationAgent]> {
  constructor(state: vscode.Memento) {
    super(state, {
      prefix: PERMISSION_PREFIX,
      key: explanationPermissionKey,
      message: (repo, agent) =>
        `${repo} の差分のコードを、解説の生成のため外部の LLM サービス（${agent}）へ送ります。許可・拒否はこのワークスペースに保存され、リセットできます`,
      allow: '送信を許可',
      deny: '拒否',
    });
  }
}
