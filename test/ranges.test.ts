import type * as vscode from 'vscode';
import { describe, it, expect } from 'vitest';
import { textDocument, Range, Uri } from './vscodeMock';
import { commentLines } from '../src/core/ranges';
import { commentRange } from '../src/ui/ranges';

describe('ranges', () => {
  it('コメント範囲を短縮された文書と空文書の最終行に収める', () => {
    const comment = { startLine: 99, endLine: 100 };
    expect(commentRange(comment, textDocument(Uri.file('/file') as vscode.Uri, 'one\ntwo'))).toEqual(
      new Range(1, 0, 1, 3),
    );
    expect(commentRange(comment, textDocument(Uri.file('/file') as vscode.Uri, ''))).toEqual(new Range(0, 0, 0, 0));
  });
  it.each([
    [new Range(0, 0, 0, 0), { startLine: 1, endLine: 1 }],
    [new Range(1, 0, 2, 0), { startLine: 2, endLine: 2 }],
    [new Range(1, 0, 2, 1), { startLine: 2, endLine: 3 }],
    [new Range(1, 0, 1, 1), { startLine: 2, endLine: 2 }],
  ])('選択範囲 %j を1始まりの行範囲へ変換する', (range, expected) => {
    expect(commentLines(range)).toEqual(expected);
  });
});
