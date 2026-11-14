export function commentLines(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): { startLine: number; endLine: number } {
  const startLine = range.start.line + 1;
  const endLine = range.end.line + (range.end.character === 0 && range.end.line > range.start.line ? 0 : 1);
  return { startLine, endLine };
}
