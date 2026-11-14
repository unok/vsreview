import { DIFF_CONTEXT_LINES, isInRange, excerpt, parseHunks } from './diff';
import type { ReviewComment } from './model';
export function anchorContext(
  content: string,
  patch: string,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
): Pick<ReviewComment, 'code' | 'hunkHeader' | 'excerpt'> {
  const lines = content.split(/\r?\n/);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw new Error('コメントの範囲がファイルの外です');
  }
  const hunk = parseHunks(patch).find((h) =>
    h.lines.some((row) => {
      const line = side === 'old' ? row.oldLine : row.newLine;
      return isInRange(line, startLine, endLine);
    }),
  );
  // リネームのみのファイルや hunk 外の行でも、対象コードを保存する。
  const first = Math.max(1, startLine - DIFF_CONTEXT_LINES);
  const last = Math.min(lines.length, endLine + DIFF_CONTEXT_LINES);
  const fallbackHeader = `@@ -${first},${last - first + 1} +${first},${last - first + 1} @@ (参照コード)`;
  const fallback = [
    fallbackHeader,
    ...lines
      .slice(first - 1, last)
      .map((line, index) => `${isInRange(index + first, startLine, endLine) ? '> ' : '  '} ${line}`),
  ].join('\n');
  return {
    code: lines.slice(startLine - 1, endLine).join('\n'),
    hunkHeader: hunk?.header ?? fallbackHeader,
    excerpt: excerpt(patch, side, startLine, endLine) || fallback,
  };
}
