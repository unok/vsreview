import * as vscode from 'vscode';
import type { ReviewComment } from '../core/model';

export function commentRange(
  comment: Pick<ReviewComment, 'startLine' | 'endLine'>,
  doc: vscode.TextDocument,
): vscode.Range {
  const start = Math.max(0, Math.min(comment.startLine - 1, doc.lineCount - 1));
  const end = Math.max(start, Math.min(comment.endLine - 1, doc.lineCount - 1));
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}
