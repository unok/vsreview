import { describe, expect, it } from 'vitest';
import { showError, showInfo, showWarning, confirmClear, showStatus } from '../src/ui/common';
import { window, warning } from './vscodeMock';
import './fixtures';

describe('common', () => {
  it('リンク以外の記号とステータスはそのまま表示する', () => {
    const text = 'node_modules \\ ` * _ < > ! (x) [x]';
    showInfo(text);
    expect(window.showInformationMessage).toHaveBeenCalledWith(`VSReview: ${text}`);
    showStatus('[x](command:y)');
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: [x](command:y)', 5000);
    showInfo('\\[x](command:y)');
    expect(window.showInformationMessage).toHaveBeenLastCalledWith('VSReview: \\[x]\\(command:y)');
  });
  it.each(['[a[b]](command:x)', '[a](x) [b](command:y)', '[a\nb](command:z)'])(
    '入れ子・複数・改行のリンク %s も無効化する',
    (text) => {
      showInfo(text);
      expect(window.showInformationMessage).toHaveBeenLastCalledWith(`VSReview: ${text.replace(/\]\(/g, ']\\(')}`);
    },
  );
  it('履歴のファイル名をリンクやコマンドリンクとして解釈させない', async () => {
    const path = '[修正](command:workbench.action.terminal.sendSequence)/x';
    const escaped = 'VSReview: [修正]\\(command:workbench.action.terminal.sendSequence)/x';
    showError(new Error(path));
    showInfo(path);
    await showWarning(path);
    expect(window.showErrorMessage).toHaveBeenCalledWith(escaped);
    expect(window.showInformationMessage).toHaveBeenCalledWith(escaped);
    expect(warning).toHaveBeenCalledWith(escaped, {});
    warning.mockResolvedValue('全削除');
    expect(await confirmClear(path)).toBe(true);
    expect(warning).toHaveBeenLastCalledWith(`VSReview: ${path}`, { modal: true }, '全削除');
  });
});
