import { isWorkingTreeUri } from './reviewTargets';
import * as vscode from 'vscode';
import { repoFile, OUTSIDE_REPOSITORY } from '../core/paths';
import { isRealFileWithin } from '../git/paths';
import type { ReviewDocuments } from './documents';
import type { RepositoryAccess } from './repositories';

export async function workingPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  documents: ReviewDocuments,
  access: RepositoryAccess,
): Promise<{ uri: vscode.Uri; position: vscode.Position } | { reason: string }> {
  const ref = await documents.resolve(document.uri);
  if (!ref) {
    return { reason: 'レビュー文書ではありません' };
  }
  if (
    document.uri.scheme === 'file' &&
    (await documents.isExpanded(document.uri)) &&
    !(await documents.matchesExpanded(ref, document))
  ) {
    return { reason: '展開したリビジョンの内容が変わりました。差分を開き直してください' };
  }
  if (isWorkingTreeUri(ref.repo, ref.path, document.uri)) {
    return { uri: vscode.Uri.file(document.uri.fsPath), position };
  }
  if (ref.empty) {
    return { reason: '空の側には対応行がありません' };
  }
  const mapping = await access.client(ref.repo).workingLine(ref.rev, ref.path, position.line + 1);
  if ('reason' in mapping) {
    return mapping;
  }
  const uri = vscode.Uri.file(repoFile(ref.repo, mapping.path ?? ref.path));
  try {
    if (!(await isRealFileWithin(ref.repo, uri.fsPath))) {
      return { reason: OUTSIDE_REPOSITORY };
    }
    const working = await vscode.workspace.openTextDocument(uri);
    if (working.isDirty) {
      return { reason: '作業ツリーに未保存の変更があります' };
    }
    if (mapping.line > working.lineCount) {
      return { reason: '対応行が作業ツリーに存在しません' };
    }
    return {
      uri,
      position: new vscode.Position(
        mapping.line - 1,
        Math.min(position.character, working.lineAt(mapping.line - 1).text.length),
      ),
    };
  } catch {
    return { reason: '作業ツリーのファイルを開けません' };
  }
}
export function registerNavigation(
  context: vscode.ExtensionContext,
  documents: ReviewDocuments,
  access: RepositoryAccess,
): void {
  const selector = { scheme: 'vsreview' };
  async function forward<T>(
    command: string,
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
    ...args: unknown[]
  ): Promise<T | undefined> {
    try {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const target = await workingPosition(doc, pos, documents, access);
      if ('reason' in target || token.isCancellationRequested) {
        return undefined;
      }
      const result = await vscode.commands.executeCommand<T>(command, target.uri, target.position, ...args);
      return token.isCancellationRequested ? undefined : result;
    } catch {
      // 暗黙の言語機能要求では、Git が使えないときも通知で編集を妨げない。
      return undefined;
    }
  }
  type Locations = vscode.Location[] | vscode.LocationLink[];
  async function locations(
    command: string,
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    const result = await forward<Locations>(command, doc, pos, token);
    // LocationLink の選択元の範囲は作業ツリーの行なので、リビジョン文書には返さない。
    return result?.map((item) =>
      'targetUri' in item ? new vscode.Location(item.targetUri, item.targetSelectionRange ?? item.targetRange) : item,
    );
  }
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: (doc, pos, token) => locations('vscode.executeDefinitionProvider', doc, pos, token),
    }),
    vscode.languages.registerReferenceProvider(selector, {
      provideReferences: (doc, pos, _options, token) =>
        forward<vscode.Location[]>('vscode.executeReferenceProvider', doc, pos, token),
    }),
    vscode.languages.registerImplementationProvider(selector, {
      provideImplementation: (doc, pos, token) => locations('vscode.executeImplementationProvider', doc, pos, token),
    }),
    vscode.languages.registerTypeDefinitionProvider(selector, {
      provideTypeDefinition: (doc, pos, token) => locations('vscode.executeTypeDefinitionProvider', doc, pos, token),
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: async (doc, pos, token) => {
        const hovers = await forward<vscode.Hover[]>('vscode.executeHoverProvider', doc, pos, token);
        // 作業ツリーのホバー範囲をリビジョン文書の行に適用しない。
        return hovers?.length ? new vscode.Hover(hovers.flatMap((hover) => hover.contents)) : undefined;
      },
    }),
  );
}
