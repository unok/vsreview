import { reviewDocuments, repository, accessFor, extensionContext, temporaryDirectory } from './fixtures';
import type * as vscode from 'vscode';
import {
  cancellationToken,
  textDocument,
  Position,
  commands,
  providers,
  Range,
  window,
  Uri,
  docs,
  workspace,
  activateTab,
  TabInputTextDiff,
} from './vscodeMock';
import { describe, expect, it, vi } from 'vitest';
import { writeFile, unlink, mkdir, symlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GitClient } from '../src/git/client';
import { commitAll } from './gitFixtures';
import { revisionUri, RevisionProvider } from '../src/ui/revisions';
import { workingPosition, registerNavigation } from '../src/ui/navigation';

async function fixture() {
  const { directory, git } = await repository();
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src/file.ts'), 'a\nb\nc');
  await commitAll(directory, 'one');
  const commit = (await git.log(0, 10))[0]!;
  const access = await accessFor(directory);
  const documents = reviewDocuments(access);
  const target = {
    repo: directory,
    commit,
    parent: await git.parent(commit),
    file: { path: 'src/file.ts', status: 'A' as const },
  };
  const uri = revisionUri(target, 'new');
  const doc = textDocument(uri, await new RevisionProvider(access).provideTextDocumentContent(uri));
  return { directory, access, documents, doc, target };
}
const token = cancellationToken;
describe('navigation', () => {
  it('行と桁を対応付け、変更行・空の側・消えたファイルでは理由を返す', async () => {
    const { directory, access, documents, doc, target } = await fixture();
    await writeFile(join(directory, 'src/file.ts'), 'a\nchanged\nc');
    expect(await workingPosition(doc, new Position(0, 100) as vscode.Position, documents, access)).toEqual({
      uri: Uri.file(join(directory, 'src/file.ts')),
      position: new Position(0, 1),
    });
    expect(await workingPosition(doc, new Position(1, 0) as vscode.Position, documents, access)).toEqual({
      reason: '作業ツリーで変更または削除された行です',
    });
    expect(
      await workingPosition(
        textDocument(revisionUri(target, 'old'), ''),
        new Position(0, 0) as vscode.Position,
        documents,
        access,
      ),
    ).toEqual({ reason: '空の側には対応行がありません' });
    expect(await workingPosition(doc, new Position(99, 0) as vscode.Position, documents, access)).toEqual({
      reason: '対応行が作業ツリーに存在しません',
    });
    await unlink(join(directory, 'src/file.ts'));
    expect(await workingPosition(doc, new Position(0, 0) as vscode.Position, documents, access)).toEqual({
      reason: '作業ツリーからファイルが削除されています',
    });
    expect(window.setStatusBarMessage).not.toHaveBeenCalled();
  });
  it('未保存の転送先を拒否し、実ファイルの選択は再マッピングしない', async () => {
    const { directory, access, documents, doc, target } = await fixture();
    const uri = Uri.file(join(directory, 'src/file.ts')) as vscode.Uri;
    const working = textDocument(uri, 'inserted\na\nb\nc', true);
    docs.push(working);
    expect(await workingPosition(doc, new Position(1, 0) as vscode.Position, documents, access)).toEqual({
      reason: '作業ツリーに未保存の変更があります',
    });
    activateTab(new TabInputTextDiff(revisionUri(target, 'old'), uri));
    expect(await workingPosition(working, new Position(2, 1) as vscode.Position, documents, access)).toEqual({
      uri,
      position: new Position(2, 1),
    });
  });
  it('全プロバイダは挿入後のURIと位置で検索し、LocationLinkとHoverの範囲を変換する', async () => {
    const { directory, access, documents, doc } = await fixture();
    await writeFile(join(directory, 'src/file.ts'), 'inserted\na\nb\nc');
    const uri = Uri.file(join(directory, 'src/file.ts')) as vscode.Uri;
    const range = new Range(2, 0, 2, 1) as vscode.Range;
    const handler = vi.fn((command: string, target: unknown, position: unknown) => {
      expect(target).toEqual(uri);
      expect(position).toEqual(new Position(2, 1));
      return Promise.resolve(
        command === 'vscode.executeHoverProvider'
          ? [{ contents: ['hover'], range }]
          : command === 'vscode.executeReferenceProvider'
            ? [{ uri, range }]
            : [{ targetUri: uri, targetRange: range, targetSelectionRange: range, originSelectionRange: range }],
      );
    });
    commands.executeCommand.mockImplementation(handler);
    registerNavigation(extensionContext(), documents, access);
    const pos = new Position(1, 1) as vscode.Position;
    const definition = providers.get('definition') as vscode.DefinitionProvider;
    expect(await definition.provideDefinition(doc, pos, token)).toEqual([{ uri, range }]);
    expect(
      await (providers.get('implementation') as vscode.ImplementationProvider).provideImplementation(doc, pos, token),
    ).toEqual([{ uri, range }]);
    expect(
      await (providers.get('typeDefinition') as vscode.TypeDefinitionProvider).provideTypeDefinition(doc, pos, token),
    ).toEqual([{ uri, range }]);
    expect(
      await (providers.get('reference') as vscode.ReferenceProvider).provideReferences(
        doc,
        pos,
        { includeDeclaration: true },
        token,
      ),
    ).toEqual([{ uri, range }]);
    expect(await (providers.get('hover') as vscode.HoverProvider).provideHover(doc, pos, token)).toEqual({
      contents: ['hover'],
    });
    expect(handler).toHaveBeenCalledTimes(5);
    commands.executeCommand.mockResolvedValueOnce([{ targetUri: uri, targetRange: range }]);
    expect(await definition.provideDefinition(doc, pos, token)).toEqual([{ uri, range }]);
    commands.executeCommand.mockResolvedValueOnce([{ uri, range }]);
    expect(await definition.provideDefinition(doc, pos, token)).toEqual([{ uri, range }]);
    commands.executeCommand.mockResolvedValueOnce([]);
    expect(await (providers.get('hover') as vscode.HoverProvider).provideHover(doc, pos, token)).toBeUndefined();
    expect(await definition.provideDefinition(doc, pos, { ...token, isCancellationRequested: true })).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(5);
  });
  it('親ディレクトリのシンボリックリンクによる脱出を拒否する', async () => {
    const { directory, access, documents, doc } = await fixture();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'file.ts'), 'a\nb\nc');
    await unlink(join(directory, 'src/file.ts'));
    await rmdir(join(directory, 'src'));
    await symlink(outside, join(directory, 'src'));
    expect(await access.client(directory).matchesWorking((await documents.resolve(doc.uri))!.rev, 'src/file.ts')).toBe(
      false,
    );
    expect(await workingPosition(doc, new Position(0, 0) as vscode.Position, documents, access)).toEqual({
      reason: 'リポジトリ外のパスは開けません',
    });
  });
  it('転送例外と対応付け後のキャンセルでは結果を返さない', async () => {
    const { directory, doc } = await fixture();
    const cancellation = { ...token };
    class CancellingGit extends GitClient {
      override async workingLine(rev: string, path: string, line: number) {
        const result = await super.workingLine(rev, path, line);
        cancellation.isCancellationRequested = true;
        return result;
      }
    }
    const access = await accessFor(directory, (repo) => new CancellingGit(repo));
    registerNavigation(extensionContext(), reviewDocuments(access), access);
    const provider = providers.get('definition') as vscode.DefinitionProvider;
    expect(await provider.provideDefinition(doc, new Position(0, 0) as vscode.Position, cancellation)).toBeUndefined();
    expect(commands.executeCommand).not.toHaveBeenCalled();
    commands.executeCommand.mockRejectedValueOnce(new Error('provider failed'));
    const normal = await accessFor(directory);
    registerNavigation(extensionContext(), reviewDocuments(normal), normal);
    expect(
      await (providers.get('definition') as vscode.DefinitionProvider).provideDefinition(
        doc,
        new Position(0, 0) as vscode.Position,
        token,
      ),
    ).toBeUndefined();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('転送先の読み込み失敗は理由を返し、暗黙の要求では通知しない', async () => {
    const { access, documents, doc } = await fixture();
    vi.spyOn(workspace, 'openTextDocument').mockRejectedValueOnce(new Error('read failed'));
    expect(await workingPosition(doc, new Position(0, 0) as vscode.Position, documents, access)).toEqual({
      reason: '作業ツリーのファイルを開けません',
    });
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('転送先プロバイダ実行後のキャンセルでは結果を捨てる', async () => {
    const { access, documents, doc } = await fixture();
    const cancellation = { ...token };
    commands.executeCommand.mockImplementationOnce(() => {
      cancellation.isCancellationRequested = true;
      return Promise.resolve([{ uri: Uri.file('/result'), range: new Range(0, 0, 0, 1) }]);
    });
    registerNavigation(extensionContext(), documents, access);
    expect(
      await (providers.get('definition') as vscode.DefinitionProvider).provideDefinition(
        doc,
        new Position(0, 0) as vscode.Position,
        cancellation,
      ),
    ).toBeUndefined();
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'vscode.executeDefinitionProvider',
      Uri.file(join(access.all()[0]!, 'src/file.ts')),
      new Position(0, 0),
    );
  });
});
