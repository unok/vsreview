import * as vscode from 'vscode';
const STATUS_MESSAGE_MS = 5000;
function withPrefix(text: string, notification = true): string {
  // 通知が解釈するリンクの区切りだけを壊す。通常の記号は表示内容の一部。
  return `VSReview: ${notification ? text.replace(/\]\(/g, ']\\(') : text}`;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function showError(error: unknown): void {
  void vscode.window.showErrorMessage(withPrefix(errorMessage(error)));
}
export function showInfo(text: string): void {
  void vscode.window.showInformationMessage(withPrefix(text));
}
export function showStatus(text: string): void {
  vscode.window.setStatusBarMessage(withPrefix(text, false), STATUS_MESSAGE_MS);
}

export function showWarning(
  text: string,
  options: vscode.MessageOptions = {},
  ...items: string[]
): Thenable<string | undefined> {
  return vscode.window.showWarningMessage(withPrefix(text, !options.modal), options, ...items);
}

export async function confirmClear(text: string, action = '全削除'): Promise<boolean> {
  return (await showWarning(text, { modal: true }, action)) === action;
}
export function registerCommand(
  context: vscode.ExtensionContext,
  name: string,
  callback: (...args: unknown[]) => unknown,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`vsreview.${name}`, (...args: unknown[]) =>
      Promise.resolve()
        .then(() => callback(...args))
        .catch(showError),
    ),
  );
}
