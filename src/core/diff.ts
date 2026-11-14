export const DIFF_CONTEXT_LINES = 3;
export interface DiffLine {
  text: string;
  kind: ' ' | '+' | '-';
  oldLine?: number;
  newLine?: number;
}
export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ') || text.startsWith('diff --cc ')) {
      current = undefined;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (match) {
      current = {
        header: text,
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
    } else if (
      current &&
      (oldLine < current.oldStart + current.oldCount || newLine < current.newStart + current.newCount)
    ) {
      const kind = text.charAt(0);
      if (kind === ' ') {
        current.lines.push({ kind, text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
      }
      if (kind === '-') {
        current.lines.push({ kind, text: text.slice(1), oldLine: oldLine++ });
      }
      if (kind === '+') {
        current.lines.push({ kind, text: text.slice(1), newLine: newLine++ });
      }
    }
  }
  return hunks;
}
export type LineMapping = { line: number; path?: string } | { reason: string };
export function mapLine(
  patch: string,
  line: number,
  options: { deleted?: boolean; renamedTo?: string } = {},
): LineMapping {
  if (!Number.isInteger(line) || line < 1) {
    return { reason: '行番号が範囲外です' };
  }
  if (options.deleted) {
    return { reason: '作業ツリーからファイルが削除されています' };
  }
  let offset = 0;
  for (const hunk of parseHunks(patch)) {
    // 旧側の長さが 0 の hunk は oldStart 行の直後への挿入を表す。
    if (line < hunk.oldStart || (hunk.oldCount === 0 && line <= hunk.oldStart)) {
      break;
    }
    if (line < hunk.oldStart + hunk.oldCount) {
      const corresponding = hunk.lines.find((row) => row.oldLine === line);
      if (corresponding?.newLine !== undefined) {
        return mapped(corresponding.newLine, options.renamedTo);
      }
      return { reason: '作業ツリーで変更または削除された行です' };
    }
    offset = hunk.newStart + hunk.newCount - (hunk.oldStart + hunk.oldCount);
    // 削除 hunk の newStart は削除範囲の直前の行を指す。
    if (hunk.newCount === 0) {
      offset++;
    }
    if (hunk.oldCount === 0) {
      offset--;
    }
  }
  return mapped(line + offset, options.renamedTo);
}
function mapped(line: number, path?: string): LineMapping {
  return path === undefined ? { line } : { line, path };
}
export function excerpt(patch: string, side: 'old' | 'new' | 'file', startLine: number, endLine: number): string {
  if (side === 'file') {
    return '';
  }
  return parseHunks(patch)
    .flatMap((hunk) => {
      const positions = hunk.lines.flatMap((row, index) => {
        const line = side === 'old' ? row.oldLine : row.newLine;
        return isInRange(line, startLine, endLine) ? [index] : [];
      });
      const first = positions[0];
      const last = positions.at(-1);
      if (first === undefined || last === undefined) {
        return [];
      }
      return [
        hunk.header,
        ...hunk.lines.slice(Math.max(0, first - DIFF_CONTEXT_LINES), last + DIFF_CONTEXT_LINES + 1).map((row) => {
          const line = side === 'old' ? row.oldLine : row.newLine;
          const mark = isInRange(line, startLine, endLine) ? '> ' : '  ';
          return `${mark}${row.kind}${row.text}`;
        }),
      ];
    })
    .join('\n');
}

export function isInRange(line: number | undefined, startLine: number, endLine: number): boolean {
  return line !== undefined && line >= startLine && line <= endLine;
}
