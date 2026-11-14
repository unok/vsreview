import { clickWorkbenchElement, visibleElementExpression } from './workbench';

// QuickPick は同じラベルの非表示行を DOM に残す。E2E で非表示行をクリックしないよう寸法も確認する。
export async function selectQuickPick(title: string, label: string): Promise<void> {
  await clickWorkbenchElement(
    visibleElementExpression(
      `(() => {
    const widget = document.querySelector('.quick-input-widget');
    if (widget?.getBoundingClientRect().width > 0 &&
        widget.querySelector('.quick-input-title')?.textContent === ${JSON.stringify(title)}) {
      return [...widget.querySelectorAll('.monaco-list-row')].find(element =>
        element.querySelector('.label-name')?.textContent === ${JSON.stringify(label)} &&
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
    }
  })()`,
      `QuickPick「${title}」の項目「${label}」が表示されませんでした`,
    ),
  );
}
