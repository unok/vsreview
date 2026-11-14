import * as vscode from 'vscode';
import { statusDecoration, parseStatusUri, statusUriParts, type StatusResource } from '../core/decorations';

export function statusUri(resource: StatusResource): vscode.Uri {
  return vscode.Uri.from(statusUriParts(resource));
}
export class StatusDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: Pick<vscode.Uri, 'scheme' | 'path' | 'query'>): vscode.FileDecoration | undefined {
    const resource = parseStatusUri(uri);
    const value = resource && statusDecoration(resource);
    return value ? { ...value, color: new vscode.ThemeColor(value.color) } : undefined;
  }
}
