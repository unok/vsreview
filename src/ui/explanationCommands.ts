import type * as vscode from 'vscode';
import { PromiseCache } from '../core/collections';
import { comparisonKey } from '../core/comparisons';
import type { CommitTarget } from '../core/documents';
import type { ChangedFile } from '../core/gitParsing';
import { isCommit } from '../core/gitParsing';
import { isRecord } from '../core/validation';
import { confirmClear, registerCommand } from './common';
import type { ExplanationPermissions } from './explanationPermissions';
import { explanationTargetLabel, type ReviewExplanations } from './explanations';
import { isPullRequestNode } from './pullRequestCommands';
import type { PullRequestsTree } from './pullRequests';
import type { ChangedFiles, RepositoryAccess } from './repositories';
import type { CommitsTree } from './trees';

export const REGENERATE_EXPLANATION = '再生成';

export interface ExplanationCommandDependencies {
  access: Pick<RepositoryAccess, 'isKnown' | 'client'>;
  changedFiles: Pick<ChangedFiles, 'get'>;
  commitsTree: Pick<CommitsTree, 'uncommittedChange'>;
  pullRequestsTree: Pick<PullRequestsTree, 'target'>;
  explanations: Pick<ReviewExplanations, 'generate' | 'has' | 'isGenerating' | 'ensureLoaded'>;
}

// Commits のコミット・Pull Requests の PR・未コミットの区分のノードから、比較の解説を生成する。
export class ExplanationCommands {
  // 比較ごとに、索引の読み込みから生成の開始までを 1 つにまとめ、確認が重なって同じ差分を再送しないようにする。
  private readonly pending = new PromiseCache<void>();
  constructor(private readonly dependencies: ExplanationCommandDependencies) {}
  async generate(node: unknown): Promise<void> {
    const request = await this.request(node);
    if (!request) {
      return;
    }
    const key = comparisonKey(request.target);
    await this.pending.get(key, async () => {
      try {
        await this.confirmAndGenerate(request);
      } finally {
        this.pending.delete(key);
      }
    });
  }
  private async confirmAndGenerate(request: { target: CommitTarget; files: ChangedFile[] }): Promise<void> {
    const { explanations } = this.dependencies;
    // 同じ比較の生成中なら、差分を送り直さずにその生成に合流する。
    if (explanations.isGenerating(request.target)) {
      await explanations.generate(request.target, request.files);
      return;
    }
    // 保存済みかを正しく判定できるよう、索引の読み込みを待つ。失敗したら生成しない。
    await explanations.ensureLoaded(request.target.repo);
    // 再生成は差分をもう一度外部へ送り、費用がかかるので、確認してから実行する。
    if (
      explanations.has(request.target) &&
      !(await confirmClear(
        `${explanationTargetLabel(request.target)} の解説を作り直しますか？差分をもう一度 AI Agent に送ります`,
        REGENERATE_EXPLANATION,
      ))
    ) {
      return;
    }
    await explanations.generate(request.target, request.files);
  }
  private async request(node: unknown): Promise<{ target: CommitTarget; files: ChangedFile[] } | undefined> {
    const { access, changedFiles } = this.dependencies;
    if (!isRecord(node) || typeof node.repo !== 'string' || !access.isKnown(node.repo)) {
      return undefined;
    }
    if (node.kind === 'commit' && isCommit(node.commit)) {
      const target = {
        repo: node.repo,
        commit: node.commit,
        parent: await access.client(node.repo).parent(node.commit),
      };
      return { target, files: await changedFiles.get(target.repo, target.commit) };
    }
    if (isPullRequestNode(node)) {
      // PR の head と merge-base を取得・検証してから比較を作る。
      const target = await this.dependencies.pullRequestsTree.target(node);
      return { target, files: await changedFiles.get(target.repo, target.commit) };
    }
    if (
      node.kind === 'uncommittedGroup' &&
      isRecord(node.change) &&
      (node.change.kind === 'staged' || node.change.kind === 'unstaged')
    ) {
      // 表示時のスナップショットではなく、実行時の変更を送る。
      return this.dependencies.commitsTree.uncommittedChange(node.repo, node.change.kind);
    }
    return undefined;
  }
}

export function registerExplanationCommands(
  context: vscode.ExtensionContext,
  commands: ExplanationCommands,
  permissions: Pick<ExplanationPermissions, 'reset'>,
): void {
  registerCommand(context, 'generateExplanation', (node) => commands.generate(node));
  registerCommand(context, 'resetExplanationPermissions', () => permissions.reset());
}
