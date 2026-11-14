import * as vscode from 'vscode';
export function allTabUris(): vscode.Uri[] {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.flatMap((tab) =>
      tab.input instanceof vscode.TabInputTextDiff
        ? [tab.input.original, tab.input.modified]
        : tab.input instanceof vscode.TabInputText
          ? [tab.input.uri]
          : [],
    ),
  );
}

export function normalTabUris(): vscode.Uri[] {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri] : [])),
  );
}
