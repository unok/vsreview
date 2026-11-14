import * as vscode from 'vscode';
import { isDocumentRef, revisionRef, type FileTarget, type DocumentRef } from '../core/documents';
import type { RepositoryAccess } from './repositories';
export function revisionUri(target: FileTarget, side: 'old' | 'new'): vscode.Uri {
  const ref = revisionRef(target, side);
  return vscode.Uri.from({
    scheme: 'vsreview',
    path: `/${ref.path}`,
    query: new URLSearchParams({ ref: JSON.stringify(ref) }).toString(),
  });
}
export function documentRef(uri: vscode.Uri): DocumentRef | undefined {
  if (uri.scheme !== 'vsreview') {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(new URLSearchParams(uri.query).get('ref') ?? 'null');
    return isDocumentRef(value) && uri.path === `/${value.path}` ? value : undefined;
  } catch {
    return undefined;
  }
}
export function resolveDocumentRef(uri: vscode.Uri, access: RepositoryAccess): DocumentRef | undefined {
  const ref = documentRef(uri);
  return ref && access.isKnown(ref.repo) ? ref : undefined;
}
export class RevisionProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly access: RepositoryAccess) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = resolveDocumentRef(uri, this.access);
    if (!ref) {
      throw new Error('レビュー文書の URI またはリポジトリが不正です');
    }
    if (ref.empty) {
      return '';
    }
    const content = await this.access.client(ref.repo).content(ref.rev, ref.path);
    if (content.binary) {
      throw new Error('バイナリファイルは表示できません');
    }
    return content.text;
  }
}
