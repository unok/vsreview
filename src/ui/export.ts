import { vsreviewConfiguration } from './configuration';
import {
  selectComments,
  isCommitComment,
  isCommentPurpose,
  type ReviewComment,
  type CommentPurpose,
} from '../core/model';
import { commitKey, reviewGroupKey } from '../core/comparisons';
import * as vscode from 'vscode';
import { groupBy } from '../core/collections';
import { shortHash, escapeIcons, replaceDisplayControls, UNCOMMITTED_LABEL } from '../core/presentation';
import { exportMarkdown, exportJson, UNKNOWN_VALUE } from '../core/export';
import { isRecord, isPositiveInteger } from '../core/validation';
import { showError, showInfo, showStatus } from './common';
import type { RepositoryAccess } from './repositories';
export interface ExportRequest {
  scope: 'all' | 'unresolved' | 'pullRequest' | 'uncommitted';
  pullRequest?: number;
  repoRoot?: string;
  purpose?: CommentPurpose;
  format: 'markdown' | 'json';
}
export function isExportRequest(value: unknown): value is ExportRequest {
  return (
    isRecord(value) &&
    (value.scope === 'all' ||
      value.scope === 'unresolved' ||
      value.scope === 'uncommitted' ||
      (value.scope === 'pullRequest' && isPositiveInteger(value.pullRequest) && typeof value.repoRoot === 'string')) &&
    (value.purpose === undefined || isCommentPurpose(value.purpose)) &&
    (value.format === 'markdown' || value.format === 'json')
  );
}
export async function exportComments(
  comments: readonly ReviewComment[],
  access: RepositoryAccess,
  {
    currentRepo,
    request,
    rewritten,
  }: {
    currentRepo?: string | undefined;
    request?: ExportRequest | Pick<ExportRequest, 'purpose'> | undefined;
    rewritten?: (comment: ReviewComment) => boolean;
  } = {},
): Promise<void> {
  const specified = request && 'scope' in request ? request : undefined;
  const purpose = request?.purpose;
  const candidates = purpose === undefined ? comments : comments.filter((comment) => comment.purpose === purpose);
  const scope =
    specified ??
    (await vscode.window.showQuickPick(
      [
        { label: '全コメント', scope: 'all' },
        { label: '特定のコミット', scope: 'commit' },
        { label: '特定の PR', scope: 'pullRequest' },
        { label: UNCOMMITTED_LABEL, scope: 'uncommitted' },
        { label: '未解決のみ', scope: 'unresolved' },
      ],
      { title: 'エクスポート範囲' },
    ));
  if (!scope) {
    return;
  }
  let selected = selectComments(candidates, { unresolvedOnly: scope.scope === 'unresolved' });
  if (scope.scope === 'uncommitted') {
    selected = candidates.filter((comment) => comment.uncommitted);
  }
  if (scope.scope === 'commit') {
    const pick = await vscode.window.showQuickPick(
      [...groupBy(candidates.filter(isCommitComment), commitKey).values()].flatMap((group) => {
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
    selected = selectComments(candidates.filter(isCommitComment), { commit: pick.commit, repoRoot: pick.repoRoot });
  }
  if (scope.scope === 'pullRequest') {
    const pick =
      specified ??
      (await vscode.window.showQuickPick(
        [
          ...groupBy(
            candidates.filter((c) => c.pullRequest),
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
    selected = selectComments(candidates, { repoRoot: pick.repoRoot, pullRequestNumber: pick.pullRequest });
  }
  const format =
    specified?.format ??
    (
      await vscode.window.showQuickPick(
        [
          { label: 'Markdown', format: 'markdown' as const },
          { label: 'JSON', format: 'json' as const },
        ],
        { title: 'エクスポート形式' },
      )
    )?.format;
  if (!format) {
    return;
  }
  const content = await exportContent(selected, access, format, rewritten, currentRepo);
  const doc = await vscode.workspace.openTextDocument({ content, language: format === 'json' ? 'json' : 'markdown' });
  await vscode.window.showTextDocument(doc);
  await copyContent(content);
}

export async function copyInstructions(
  comments: readonly ReviewComment[],
  access: RepositoryAccess,
  rewritten: (comment: ReviewComment) => boolean,
): Promise<void> {
  if (!comments.length) {
    showInfo('コピー対象の未解決コメントがありません');
    return;
  }
  await copyContent(await exportContent(comments, access, 'markdown', rewritten));
}

async function copyContent(content: string): Promise<void> {
  await vscode.env.clipboard.writeText(content);
  showStatus('コメントをクリップボードにコピーしました');
}

async function exportContent(
  comments: readonly ReviewComment[],
  access: RepositoryAccess,
  format: ExportRequest['format'],
  rewritten?: (comment: ReviewComment) => boolean,
  currentRepo?: string,
): Promise<string> {
  const branches = new Map<string, string>();
  for (const repo of new Set([...comments.map((c) => c.repoRoot), ...(currentRepo ? [currentRepo] : [])])) {
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
  const configuration = vsreviewConfiguration();
  const [instructions, questionInstructions] = ['export.instructions', 'export.questionInstructions'].map((key) => {
    const value: unknown = configuration.inspect(key)?.globalValue;
    return typeof value === 'string' ? value : '';
  });
  return format === 'json'
    ? exportJson(comments, branches, instructions, questionInstructions, rewritten)
    : exportMarkdown(comments, branches, instructions, questionInstructions, rewritten);
}
