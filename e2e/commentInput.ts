import { clickWorkbenchElement, visibleElementExpression } from './workbench';
import * as vscode from 'vscode';
import { poll, waitForActiveEditor } from './timeouts';

export async function createCommentInput(): Promise<vscode.TextDocument> {
  const existing = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
  await vscode.commands.executeCommand('workbench.action.addComment');
  const document = await poll(
    () =>
      Promise.resolve(
        vscode.workspace.textDocuments.find(
          (doc) =>
            doc.uri.scheme === 'comment' && !doc.isClosed && doc.getText() === '' && !existing.has(doc.uri.toString()),
        ),
      ),
    '新しいコメント入力用文書が作られませんでした',
  );
  // 入力文書の生成はフォーカス移動より先に通知されるため、生成を待ってから新しい欄へ移す。
  await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
  return document;
}

// 拡張APIには既存コメント入力欄へ戻る操作がないため、実画面上の入力欄をクリックする。
export async function clickCommentInput(uri: Pick<vscode.Uri, 'toString'>): Promise<void> {
  await clickWorkbenchElement(
    visibleElementExpression(
      `[...document.querySelectorAll('.review-widget .monaco-editor textarea')].find(element => {
      if (element.closest('.monaco-editor')?.getAttribute('data-uri') !== ${JSON.stringify(uri.toString())}) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })`,
      '表示中のコメント入力欄がありません',
    ),
  );
  await waitForActiveEditor(uri, '指定したコメント入力欄にフォーカスが移りませんでした');
}
