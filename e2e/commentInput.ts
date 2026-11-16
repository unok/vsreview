import { clickWorkbenchElement, visibleElementExpression } from './workbench';
import * as vscode from 'vscode';
import { poll, waitForActiveEditor } from './timeouts';
import type { CommentPurpose } from '../src/core/model';

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

export async function clickCommentSaveButton(uri: vscode.Uri, purpose: CommentPurpose): Promise<void> {
  await clickWorkbenchElement(
    visibleElementExpression(
      `(() => {
        const editor = [...document.querySelectorAll('.review-widget .monaco-editor')].find(element =>
          element.getAttribute('data-uri') === ${JSON.stringify(uri.toString())});
        const buttons = [...(editor?.closest('.review-widget')?.querySelectorAll('.form-actions .other-actions .monaco-button') ?? [])];
        if (buttons.length < 2) { return undefined; }
        const labels = buttons.map(button => button.textContent.trim());
        if (buttons.length > 2) {
          throw new Error('保存ボタンが ' + buttons.length + ' 個あります（期待値: 2 個）: ' + JSON.stringify(labels));
        }
        // VS Code はボタンを右から並べるため、DOM の先頭の主ボタン（修正依頼）が右に来る。
        if (labels[0] !== '修正依頼として保存' || labels[1] !== '質問として保存') {
          throw new Error('保存ボタンのタイトルまたは順序が違います: ' + JSON.stringify(labels));
        }
        const [fixRect, questionRect] = buttons.map(button => button.getBoundingClientRect());
        if (fixRect.width <= 0 || questionRect.width <= 0) { return undefined; }
        if (questionRect.x >= fixRect.x || Math.abs(questionRect.y - fixRect.y) > 1) {
          throw new Error('左に質問、右に修正依頼の保存ボタンが並んでいません');
        }
        if (buttons[0].classList.contains('secondary') || !buttons[1].classList.contains('secondary')) {
          throw new Error('修正依頼が主ボタンになっていません');
        }
        return buttons[${purpose === 'fix' ? 0 : 1}];
      })()`,
      '修正依頼・質問の保存ボタンが表示されませんでした',
    ),
  );
}
