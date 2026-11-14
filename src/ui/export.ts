import { selectComments, type ReviewComment } from '../core/model';
import { commitKey, reviewGroupKey } from '../core/comparisons';
import * as vscode from 'vscode';
import { groupBy } from '../core/collections';
import { shortHash, escapeIcons, replaceDisplayControls } from '../core/presentation';
import { exportMarkdown, exportJson, UNKNOWN_VALUE, type ExportPurpose } from '../core/export';
import { isRecord, isPositiveInteger } from '../core/validation';
import { showError, showStatus } from './common';
import type { RepositoryAccess } from './repositories';
export interface ExportRequest {
  scope: 'all' | 'unresolved' | 'pullRequest';
  pullRequest?: number;
  repoRoot?: string;
  purpose?: ExportPurpose;
  format: 'markdown' | 'json';
}
export function isExportRequest(value: unknown): value is ExportRequest {
  return (
    isRecord(value) &&
    (value.scope === 'all' ||
      value.scope === 'unresolved' ||
      (value.scope === 'pullRequest' && isPositiveInteger(value.pullRequest) && typeof value.repoRoot === 'string')) &&
    (value.purpose === undefined || value.purpose === 'fix' || value.purpose === 'question') &&
    (value.format === 'markdown' || value.format === 'json')
  );
}
export async function exportComments(
  comments: readonly ReviewComment[],
  access: RepositoryAccess,
  { currentRepo, request }: { currentRepo?: string | undefined; request?: ExportRequest | undefined } = {},
): Promise<void> {
  const scope =
    request ??
    (await vscode.window.showQuickPick(
      [
        { label: '全コメント', scope: 'all' },
        { label: '特定のコミット', scope: 'commit' },
        { label: '特定の PR', scope: 'pullRequest' },
        { label: '未解決のみ', scope: 'unresolved' },
      ],
      { title: 'エクスポート範囲' },
    ));
  if (!scope) {
    return;
  }
  let selected = selectComments(comments, { unresolvedOnly: scope.scope === 'unresolved' });
  if (scope.scope === 'commit') {
    const pick = await vscode.window.showQuickPick(
      [
        ...groupBy(
          comments.filter((c) => !c.pullRequest),
          commitKey,
        ).values(),
      ].flatMap((group) => {
        const c = group[0];
        return c
          ? [
              {
                label: `${shortHash(c.commit)} ${escapeIcons(c.subject)}`,
                description: c.repoRoot,
                commit: c.commit,
                repoRoot: c.repoRoot,
              },
            ]
          : [];
      }),
      { title: 'コミットを選択' },
    );
    if (!pick) {
      return;
    }
    selected = selectComments(
      comments.filter((c) => !c.pullRequest),
      { commit: pick.commit, repoRoot: pick.repoRoot },
    );
  }
  if (scope.scope === 'pullRequest') {
    const pick =
      request ??
      (await vscode.window.showQuickPick(
        [
          ...groupBy(
            comments.filter((c) => c.pullRequest),
            reviewGroupKey,
          ).values(),
        ].flatMap((group) => {
          const comment = group[0];
          return comment?.pullRequest
            ? [
                {
                  label: `PR #${comment.pullRequest.number} ${escapeIcons(replaceDisplayControls(comment.pullRequest.title))}`,
                  description: comment.repoRoot,
                  repoRoot: comment.repoRoot,
                  pullRequest: comment.pullRequest.number,
                },
              ]
            : [];
        }),
        { title: 'PR を選択' },
      ));
    if (!pick || pick.repoRoot === undefined || pick.pullRequest === undefined) {
      return;
    }
    selected = selectComments(comments, { repoRoot: pick.repoRoot, pullRequestNumber: pick.pullRequest });
  }
  const format =
    request?.format ??
    (
      await vscode.window.showQuickPick(
        [
          { label: 'Markdown', format: 'markdown' },
          { label: 'JSON', format: 'json' },
        ],
        { title: 'エクスポート形式' },
      )
    )?.format;
  if (!format) {
    return;
  }
  const purpose = request
    ? (request.purpose ?? 'fix')
    : (
        await vscode.window.showQuickPick(
          [
            { label: '修正依頼', purpose: 'fix' as const },
            { label: '質問', purpose: 'question' as const },
          ],
          { title: 'エクスポート目的' },
        )
      )?.purpose;
  if (!purpose) {
    return;
  }
  const branches = new Map<string, string>();
  for (const repo of new Set([...selected.map((c) => c.repoRoot), ...(currentRepo ? [currentRepo] : [])])) {
    if (!access.isKnown(repo)) {
      branches.set(repo, UNKNOWN_VALUE);
      continue;
    }
    try {
      const branch = await access.client(repo).branch();
      branches.set(repo, 'name' in branch ? branch.name : `detached HEAD (${shortHash(branch.head)})`);
    } catch (error) {
      branches.set(repo, UNKNOWN_VALUE);
      showError(error);
    }
  }
  const value: unknown = vscode.workspace
    .getConfiguration('vsreview')
    .inspect(purpose === 'question' ? 'export.questionInstructions' : 'export.instructions')?.globalValue;
  const instructions = typeof value === 'string' ? value : '';
  const content =
    format === 'json'
      ? exportJson(selected, branches, instructions, purpose)
      : exportMarkdown(selected, branches, instructions, purpose);
  const doc = await vscode.workspace.openTextDocument({ content, language: format === 'json' ? 'json' : 'markdown' });
  await vscode.window.showTextDocument(doc);
  await vscode.env.clipboard.writeText(content);
  showStatus('コメントをクリップボードにコピーしました');
}
