import { vsreviewConfiguration } from './configuration';
import * as vscode from 'vscode';
import { buildFileTree, flattenFileTree, type FileTreeNode } from '../core/fileTree';
import type { ChangedFile } from '../core/gitParsing';

export type FileView = 'tree' | 'list';
export function fileView(repo?: string): FileView {
  return vsreviewConfiguration(repo).get<unknown>('fileView') === 'list' ? 'list' : 'tree';
}
export function compactFolders(repo?: string): boolean {
  return (
    vscode.workspace
      .getConfiguration('explorer', repo ? vscode.Uri.file(repo) : undefined)
      .get<unknown>('compactFolders') !== false
  );
}
export function displayedFileTree(files: readonly ChangedFile[], repo?: string): FileTreeNode[] {
  return fileView(repo) === 'tree'
    ? buildFileTree(files, compactFolders(repo))
    : files.map((file) => ({ kind: 'file', name: file.path, file }));
}
export function orderedFiles(files: readonly ChangedFile[], repo?: string): readonly ChangedFile[] {
  return flattenFileTree(displayedFileTree(files, repo));
}

export function updateFileView(view: FileView, repo?: string): Thenable<void> {
  const configuration = vsreviewConfiguration(repo);
  const values = configuration.inspect('fileView');
  // Global に保存してもワークスペース設定が優先されるため、既存の最も具体的な保存先を使う。
  const target =
    values?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : values?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  return configuration.update('fileView', view, target);
}
