import * as vscode from 'vscode';
export const E2E_TIMEOUT_MS = 60000;
export const E2E_POLL_MS = 250;
// VS Code のメニューは表示後100msでクリック処理を登録するため、次の項目クリックまで余裕を持って待つ。
export const CONTEXT_MENU_SETTLE_MS = 250;

export async function poll<T>(condition: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, E2E_POLL_MS));
  }
  throw new Error(message);
}

export async function waitForActiveEditor(uri: Pick<vscode.Uri, 'toString'>, message: string): Promise<void> {
  await poll(
    () =>
      Promise.resolve(vscode.window.activeTextEditor?.document.uri.toString() === uri.toString() ? true : undefined),
    message,
  );
}
