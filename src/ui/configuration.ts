import * as vscode from 'vscode';

export function vsreviewConfiguration(repo?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('vsreview', repo ? vscode.Uri.file(repo) : undefined);
}
