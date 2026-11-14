import {
  revisionSnapshots,
  KeyedState,
  archiveClock,
  accessFor,
  extensionContext,
  repository,
  temporaryDirectory,
  disposeAfter,
  gitProcesses,
  waitFor,
} from './fixtures';
import { revisionUri } from '../src/ui/revisions';
import { FilesTree } from '../src/ui/files';
import { ReviewComments } from '../src/ui/comments';
import { workingPosition } from '../src/ui/navigation';
import { RevisionSnapshots } from '../src/ui/revisionSnapshots';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { lstat, readFile, unlink, writeFile, mkdir, symlink, rm, utimes, chmod } from 'node:fs/promises';
import { RevisionArchives } from '../src/ui/revisionArchives';
import { ReviewDocuments } from '../src/ui/documents';
import { ChangedFiles } from '../src/ui/repositories';
import { revisionRef } from '../src/core/documents';
import { commitAll } from './gitFixtures';
import {
  activateTab,
  workspaceFolderConfiguration,
  window,
  rangeProviderAssigned,
  controller,
  globalConfiguration,
  TabInputText,
  TabInputTextDiff,
  textDocument,
  Uri,
  warning,
  workspaceConfiguration,
} from './vscodeMock';

async function fixture(storage = true) {
  const { directory, git } = await repository();
  await writeFile(join(directory, 'deleted.ts'), "import { value } from './lib';\nvalue;\n");
  await writeFile(join(directory, 'lib.ts'), 'export const value = 1;\n');
  await commitAll(directory, 'initial');
  const parent = (await git.head())!;
  await unlink(join(directory, 'deleted.ts'));
  await writeFile(join(directory, 'lib.ts'), 'export const value = 2;\n');
  await commitAll(directory, 'delete');
  const commit = (await git.log(0, 1))[0]!;
  const target = { repo: directory, commit, parent, file: { path: 'deleted.ts', status: 'D' as const } };
  const access = await accessFor(directory);
  const state = new KeyedState();
  const context = extensionContext(
    state,
    storage ? { storageUri: Uri.file(await temporaryDirectory()) as vscode.Uri } : {},
  );
  const archives = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
  await archives.initialize();
  const documents = new ReviewDocuments(access, archives);
  return { target, archives, documents, state, context, access, git };
}
describe('revisionArchiveDocuments', () => {
  it('サブパッケージのパターンリンクは復元後もコメント対象にしない', async () => {
    const { target, archives, documents, context, access, git } = await fixture();
    const path = 'packages/crawler/src/deleted.ts';
    await mkdir(join(target.repo, 'packages/crawler/src'), { recursive: true });
    await writeFile(join(target.repo, path), 'historical');
    await commitAll(target.repo, 'package');
    const parent = (await git.head())!;
    await unlink(join(target.repo, path));
    await commitAll(target.repo, 'delete package source');
    await mkdir(join(target.repo, 'packages/crawler/node_modules'));
    await writeFile(join(target.repo, 'packages/crawler/node_modules/library.ts'), 'dependency');
    warning.mockResolvedValue('許可');
    const commit = (await git.log(0, 1))[0]!;
    const { left } = await documents.diffUris({ ...target, parent, commit, file: { path, status: 'D' } });
    const linked = Uri.file(join(dirname(left.fsPath), '../node_modules/library.ts')) as vscode.Uri;
    expect(await readFile(linked.fsPath, 'utf8')).toBe('dependency');
    expect(await archives.owns(linked)).toBe(false);
    expect(await documents.resolve(linked)).toBeUndefined();
    expect(await documents.isCommentable(textDocument(linked, 'dependency'))).toBe(false);
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    await restored.owns(left);
    expect(await restored.owns(linked)).toBe(false);
    expect(await new ReviewDocuments(access, restored).resolve(linked)).toBeUndefined();
  });
  it('削除ファイルと定義先を同じ旧リビジョンに解決し、再起動でコメント識別子を保つ', async () => {
    const { target, archives, documents, context, access } = await fixture();
    warning.mockResolvedValue('許可');
    const uris = await documents.diffUris(target);
    expect(uris.left.scheme).toBe('file');
    expect(uris.right.scheme).toBe('vsreview');
    expect(uris.left.fsPath).not.toBe(join(target.repo, 'deleted.ts'));
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    expect(await documents.openDiffRefs()).toEqual([revisionRef(target, 'old')]);
    const doc = textDocument(uris.left, await readFile(uris.left.fsPath, 'utf8'));
    expect(await documents.assertCommentable(doc)).toEqual(revisionRef(target, 'old'));
    const followed = Uri.file(join(dirname(uris.left.fsPath), 'lib.ts')) as vscode.Uri;
    const comparisonTab = window.tabGroups.activeTabGroup.activeTab!;
    activateTab(new TabInputText(followed));
    window.tabGroups.activeTabGroup.tabs.unshift(comparisonTab);
    expect(await documents.resolve(followed)).toMatchObject({
      repo: target.repo,
      rev: target.parent,
      path: 'lib.ts',
      side: 'old',
    });
    expect(await documents.isCommentable(textDocument(followed, 'export const value = 1;\n'))).toBe(true);
    await expect(documents.assertCommentable(textDocument(followed, 'edited'))).rejects.toThrow(
      '展開したリビジョンの内容',
    );
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    await restored.initialize();
    await restored.owns(followed);
    expect(await new ReviewDocuments(access, restored).resolve(followed)).toMatchObject({
      rev: target.parent,
      path: 'lib.ts',
    });
    await new ReviewDocuments(access, restored).diffUris(target);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockResolvedValue('全削除');
    await archives.clear();
    expect(await documents.resolve(followed)).toBeUndefined();
    expect(
      await new ReviewDocuments(
        access,
        RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access))),
      ).resolve(followed),
    ).toBeUndefined();
  });
  it.each(['', '\uFEFF'])('BOM %j の展開文書は範囲表示・追加・行対応で同じ改変判定を使う', async (bom) => {
    const { target, documents, access, git } = await fixture();
    await writeFile(join(target.repo, 'bom.ts'), bom + 'export const value = 1;\n');
    await commitAll(target.repo, 'BOM');
    const commit = (await git.log(0, 1))[0]!;
    const ref = revisionRef({ ...target, commit, file: { path: 'bom.ts', status: 'M' } }, 'new');
    warning.mockResolvedValue('許可');
    const uri = await documents.revisionFileUri(ref);
    activateTab(new TabInputText(uri));
    const doc = textDocument(uri, 'export const value = 1;\n');
    expect(await documents.isCommentable(doc)).toBe(true);
    expect(await documents.assertCommentable(doc)).toMatchObject({ rev: ref.rev, path: ref.path, side: ref.side });
    expect(await workingPosition(doc, new vscode.Position(0, 0), documents, access)).toMatchObject({
      uri: vscode.Uri.file(join(target.repo, 'bom.ts')),
    });
    const edited = textDocument(uri, 'edited', true);
    expect(await documents.isCommentable(edited)).toBe(false);
    await expect(documents.assertCommentable(edited)).rejects.toThrow('展開したリビジョンの内容');
    for (const change of ['external', 'missing']) {
      if (change === 'external') {
        await chmod(uri.fsPath, 0o600);
        await writeFile(uri.fsPath, 'external');
      } else {
        await unlink(uri.fsPath);
      }
      expect(await documents.isCommentable(doc)).toBe(false);
      await expect(documents.assertCommentable(doc)).rejects.toThrow('展開したリビジョンの内容');
      expect(await workingPosition(doc, new vscode.Position(0, 0), documents, access)).toEqual({
        reason: '展開したリビジョンの内容が変わりました。差分を開き直してください',
      });
    }
  });
  it('差分タブなしで保存文脈を復元し、直近に使った比較で通常文書へコメントできる', async () => {
    const { target, documents, access, context, git } = await fixture();
    warning.mockResolvedValue('許可');
    const pair = await documents.diffUris(target);
    await writeFile(join(target.repo, 'extra.ts'), 'extra');
    await commitAll(target.repo, 'next');
    await documents.diffUris({ ...target, commit: (await git.log(0, 1))[0]! });
    await documents.diffUris(target);
    const followed = vscode.Uri.file(join(dirname(pair.left.fsPath), 'lib.ts'));
    activateTab(new TabInputText(followed));
    const restored = new ReviewDocuments(
      access,
      RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access))),
    );
    const doc = textDocument(followed, 'export const value = 1;\n');
    expect(await restored.resolve(followed)).toMatchObject({
      commit: { hash: target.commit.hash },
      side: 'old',
      path: 'lib.ts',
    });
    expect(await restored.isCommentable(doc)).toBe(true);
    expect(await restored.assertCommentable(doc)).toMatchObject({
      commit: { hash: target.commit.hash },
      path: 'lib.ts',
    });
  });
  it('拒否を記録し、リセット・保存領域なし・展開失敗を扱う', async () => {
    const { target, archives, documents } = await fixture();
    warning.mockResolvedValue('拒否');
    expect((await documents.diffUris(target)).left.scheme).toBe('vsreview');
    warning.mockResolvedValue('許可');
    expect((await documents.diffUris(target)).left.scheme).toBe('vsreview');
    expect(warning).toHaveBeenCalledTimes(1);
    await archives.resetPermissions();
    expect((await documents.diffUris(target)).left.scheme).toBe('file');
    const noStorage = await fixture(false);
    expect((await noStorage.documents.diffUris(noStorage.target)).left.scheme).toBe('vsreview');
    expect(warning).toHaveBeenCalledTimes(2);
    const missing = { ...target, parent: 'f'.repeat(40) };
    window.showErrorMessage.mockClear();
    expect((await documents.diffUris(missing)).left.scheme).toBe('vsreview');
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('VSReview:'));
    await documents.diffUris(missing);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
  });
  it('ワークスペースのリンク設定を無視し、不正なユーザー設定を通知する', async () => {
    const { target, documents } = await fixture();
    warning.mockResolvedValue('許可');
    workspaceConfiguration.set('vsreview.revisionArchive.linkPaths', ['../outside']);
    expect((await documents.diffUris(target)).left.scheme).toBe('file');
    globalConfiguration.set('vsreview.revisionArchive.linkPaths', ['../outside']);
    expect((await documents.diffUris(target)).left.scheme).toBe('vsreview');
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: 展開先のパスが不正です: ../outside');
  });
  it('展開ファイルの外部編集を内容で検出し、行対応へ進まない', async () => {
    const { target, documents, access } = await fixture();
    warning.mockResolvedValue('許可');
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const original = await readFile(left.fsPath, 'utf8');
    await chmod(left.fsPath, 0o600);
    await writeFile(left.fsPath, 'externally changed');
    expect(await workingPosition(textDocument(left, original), new vscode.Position(0, 0), documents, access)).toEqual({
      reason: '展開したリビジョンの内容が変わりました。差分を開き直してください',
    });
  });
  it('開いている比較を優先し、閉じた後は直近の保存文脈を使う', async () => {
    const { target, documents, git } = await fixture();
    warning.mockResolvedValue('許可');
    const original = await documents.diffUris(target);
    await writeFile(join(target.repo, 'extra.ts'), 'extra');
    await commitAll(target.repo, 'head');
    const commit = (await git.log(0, 1))[0]!;
    const second = await documents.diffUris({ ...target, commit });
    activateTab(new TabInputTextDiff(second.left, second.right));
    const followed = Uri.file(join(dirname(original.left.fsPath), 'lib.ts')) as vscode.Uri;
    expect((await documents.resolve(followed))?.commit.hash).toBe(commit.hash);
    activateTab(new TabInputText(followed));
    expect((await documents.resolve(followed))?.commit.hash).toBe(commit.hash);
  });
  it('外部 PR の旧側はリポジトリの許可だけで展開する', async () => {
    const { target, archives } = await fixture();
    warning.mockResolvedValue('許可');
    const ref = revisionRef(
      {
        ...target,
        pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent, isCrossRepository: true },
      },
      'old',
    );
    expect((await archives.uri(ref))?.scheme).toBe('file');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.not.stringContaining('外部 PR'), { modal: true }, '許可', '拒否');
  });
  it('復元に一度失敗しても次の要求で所有と参照を回復する', async () => {
    const { target, documents, access, context } = await fixture();
    warning.mockResolvedValue('許可');
    const pair = await documents.diffUris(target);
    const snapshots = new RevisionSnapshots(access, new ChangedFiles(access));
    vi.spyOn(snapshots, 'get').mockRejectedValueOnce(new Error('temporary failure'));
    const restored = RevisionArchives.create(context, access, snapshots);
    expect(await restored.owns(pair.left)).toBe(false);
    expect(await restored.owns(pair.left)).toBe(true);
    expect(await restored.refs(pair.left)).toMatchObject([{ rev: target.parent, side: 'old' }]);
  });
  it('保存した URI 対がなく同じ組に複数比較が一致すれば選ばない', async () => {
    const { target, documents, access, context, state } = await fixture();
    warning.mockResolvedValue('許可');
    const modified = { ...target, file: { path: 'lib.ts', status: 'M' as const } };
    const local = await documents.diffUris(modified);
    const pr = { ...modified, pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent } };
    const pair = await documents.diffUris(pr);
    expect(pair).toEqual(local);
    await state.update('vsreview.archivePairs', undefined);
    activateTab(new TabInputTextDiff(pair.left, pair.right));
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    expect(await new ReviewDocuments(access, restored).openDiffRefs()).toEqual([]);
  });
  it('PR の merge-base を使い、同じ展開を使う複数比較を区別する', async () => {
    const { target, documents, git } = await fixture();
    warning.mockResolvedValue('許可');
    const original = await documents.diffUris(target);
    await writeFile(join(target.repo, 'extra.ts'), 'extra');
    await commitAll(target.repo, 'head');
    const commit = (await git.log(0, 1))[0]!;
    expect(commit.parents[0]).not.toBe(target.parent);
    const pr = { ...target, commit, pullRequest: { number: 12, headRefOid: commit.hash, mergeBase: target.parent } };
    const uris = await documents.diffUris(pr);
    expect(uris.left.fsPath).toBe(original.left.fsPath);
    expect(uris.left.query).toBe('');
    expect(uris.left.toString()).toBe(original.left.toString());
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    expect(await documents.resolve(uris.left)).toMatchObject({
      rev: target.parent,
      commit: { hash: commit.hash },
      pullRequest: { number: 12 },
    });
    const followed = Uri.file(join(dirname(uris.left.fsPath), 'lib.ts')) as vscode.Uri;
    expect((await documents.resolve(followed))?.pullRequest?.number).toBe(12);
    expect(
      await documents.resolve(followed, {
        commit: target.commit.hash,
        comparison: { repoRoot: target.repo, commit: target.commit.hash, parent: target.parent },
      }),
    ).toBeUndefined();
    documents.recordActiveDiff(await documents.openDiffs());
    const diffTab = window.tabGroups.activeTabGroup.activeTab!;
    activateTab(new TabInputText(followed));
    window.tabGroups.activeTabGroup.tabs.unshift(diffTab);
    expect((await documents.resolve(followed))?.rev).toBe(target.parent);
  });
  it('展開を開く間と開いているタブを LRU から保護する', async () => {
    archiveClock();
    const { target, archives, git } = await fixture();
    warning.mockResolvedValue('許可');
    globalConfiguration.set('vsreview.revisionArchive.maxCount', 2);
    const uris: vscode.Uri[] = [];
    await archives.withLease(async () => {
      uris.push((await archives.uri(revisionRef(target, 'old')))!);
      uris.push((await archives.uri(revisionRef({ ...target, file: { path: 'lib.ts', status: 'M' } }, 'new')))!);
      await writeFile(join(target.repo, 'lib.ts'), 'export const value = 3;\n');
      await commitAll(target.repo, 'third');
      const commit = (await git.log(0, 1))[0]!;
      uris.push(
        (await archives.uri(
          revisionRef({ ...target, commit, parent: target.commit.hash, file: { path: 'lib.ts', status: 'M' } }, 'new'),
        ))!,
      );
      await archives.prune([]);
      await expect(lstat(uris[0]!.fsPath)).resolves.toBeDefined();
      activateTab(new TabInputText(uris[0]!));
    });
    await archives.prune();
    await expect(lstat(uris[0]!.fsPath)).resolves.toBeDefined();
    await expect(lstat(uris[1]!.fsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(uris[2]!.fsPath)).resolves.toBeDefined();
  });
  it('同じ内容でも旧側は作業ツリーから分離し、空の旧側は仮想文書にする', async () => {
    const { target, documents, git } = await fixture();
    warning.mockResolvedValue('許可');
    const old = (await git.log(0, 1, target.parent))[0]!;
    const root = {
      ...target,
      commit: old,
      parent: await git.parent(old),
      file: { path: 'lib.ts', status: 'A' as const },
    };
    expect((await documents.diffUris(root)).left.scheme).toBe('vsreview');
    await writeFile(join(target.repo, 'lib.ts'), 'export const value = 1;\n');
    const same = await documents.diffUris({ ...root, file: { path: 'lib.ts', status: 'M' }, parent: old.hash });
    expect(same.left.fsPath).not.toBe(join(target.repo, 'lib.ts'));
    expect(same.right.fsPath).toBe(join(target.repo, 'lib.ts'));
    expect(same.left.query).toBe('');
    activateTab(new TabInputTextDiff(same.left, same.right));
    expect((await documents.resolve(same.left))?.side).toBe('old');
  });
  it('確認を閉じた場合は記録せず、次の要求でもう一度確認する', async () => {
    const { target, documents, state } = await fixture();
    warning.mockResolvedValue(undefined);
    expect((await documents.diffUris(target)).left.scheme).toBe('vsreview');
    expect(state.keys()).toEqual([]);
    warning.mockResolvedValue('許可');
    expect((await documents.diffUris(target)).left.scheme).toBe('file');
    expect(warning).toHaveBeenCalledTimes(2);
  });
  it('リンク配下には警告もコメントも適用せず、ユーザー設定でリンクする', async () => {
    const { target, documents, archives } = await fixture();
    await mkdir(join(target.repo, 'deps'));
    await writeFile(join(target.repo, 'deps/library.ts'), 'current');
    workspaceFolderConfiguration.set(
      Uri.file(target.repo).toString(),
      new Map([['vsreview.revisionArchive.linkPaths', ['../outside']]]),
    );
    globalConfiguration.set('vsreview.revisionArchive.linkPaths', ['deps']);
    warning.mockResolvedValue('許可');
    const { left } = await documents.diffUris(target);
    const linked = Uri.file(join(dirname(left.fsPath), 'deps/library.ts')) as vscode.Uri;
    expect(await readFile(linked.fsPath, 'utf8')).toBe('current');
    expect(await archives.owns(linked)).toBe(false);
    expect(await documents.resolve(linked)).toBeUndefined();
    expect(await documents.isCommentable(textDocument(linked, 'current'))).toBe(false);
    expect(await archives.isSource(linked)).toBe(false);
    expect(await documents.canShowComments(left, new Set([left.toString()]))).toBe(true);
    const current = Uri.file(join(target.repo, 'lib.ts')) as vscode.Uri;
    expect(await documents.canShowComments(current, new Set([current.toString()]))).toBe(false);
  });
  it('保存領域がシンボリックリンク配下でも開いてコメントできる', async () => {
    const { target, context, access } = await fixture();
    const base = await temporaryDirectory();
    const actual = await temporaryDirectory();
    await symlink(actual, join(base, 'storage'));
    Object.assign(context, { storageUri: Uri.file(join(base, 'storage')) });
    const archives = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    const documents = new ReviewDocuments(access, archives);
    warning.mockResolvedValue('許可');
    const { left } = await documents.diffUris(target);
    expect(left.scheme).toBe('file');
    const pair = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(pair.left, pair.right));
    expect(await documents.assertCommentable(textDocument(left, await readFile(left.fsPath, 'utf8')))).toEqual(
      revisionRef(target, 'old'),
    );
  });
  it('シンボリックリンクと対象パスなしは通知せず仮想文書へ戻す', async () => {
    const { target, git, documents } = await fixture();
    await symlink('lib.ts', join(target.repo, 'alias.ts'));
    await commitAll(target.repo, 'symlink');
    const commit = (await git.log(0, 1))[0]!;
    warning.mockResolvedValue('許可');
    const link = await documents.revisionFileUri(
      revisionRef({ ...target, commit, file: { path: 'alias.ts', status: 'A' } }, 'new'),
    );
    expect(link.scheme).toBe('vsreview');
    const missing = await documents.revisionFileUri(
      revisionRef({ ...target, file: { path: 'missing', status: 'M' } }, 'old'),
    );
    expect(missing.scheme).toBe('vsreview');
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('復元は該当パスを要求するまで Git を呼ばず、不正値と消えた展開を捨てる', async () => {
    const { target, documents, context, access, state } = await fixture();
    warning.mockResolvedValue('許可');
    const { left } = await documents.diffUris(target);
    const saved = state.get<unknown[]>('vsreview.archiveContexts')!;
    await state.update('vsreview.archiveContexts', [
      ...saved,
      null,
      { ...revisionRef(target, 'old'), repo: '/unknown' },
    ]);
    const revisions = new RevisionSnapshots(access, new ChangedFiles(access));
    const processes = gitProcesses();
    const restored = RevisionArchives.create(context, access, revisions);
    await restored.initialize();
    expect(processes).not.toHaveBeenCalled();
    await restored.owns(Uri.file('/unrelated') as vscode.Uri);
    expect(processes).not.toHaveBeenCalled();
    await rm(dirname(left.fsPath), { recursive: true });
    await restored.owns(left);
    expect(processes).not.toHaveBeenCalled();
    expect(await restored.owns(left)).toBe(false);
    expect(await restored.refs(left)).toEqual([]);
  });
  it('比較が曖昧な定義先へのコメントを拒否する', async () => {
    const { target, documents, git } = await fixture();
    warning.mockResolvedValue('許可');
    const local = await documents.diffUris(target);
    const { left } = local;
    await writeFile(join(target.repo, 'extra.ts'), 'extra');
    await commitAll(target.repo, 'head');
    const commit = (await git.log(0, 1))[0]!;
    const pr = await documents.diffUris({
      ...target,
      commit,
      pullRequest: { number: 12, headRefOid: commit.hash, mergeBase: target.parent },
    });
    const followed = Uri.file(join(dirname(left.fsPath), 'lib.ts')) as vscode.Uri;
    activateTab(new TabInputText(followed));
    window.tabGroups.activeTabGroup.tabs.unshift(
      { input: new TabInputTextDiff(local.left, local.right) },
      { input: new TabInputTextDiff(pr.left, pr.right) },
    );
    expect(await documents.resolve(followed)).toBeUndefined();
    await expect(documents.assertCommentable(textDocument(followed, 'export const value = 1;\n'))).rejects.toThrow(
      '複数',
    );
  });
  it('展開先から作業ツリーの対応行へ移動し、Files の未変更ファイルも展開先で開く', async () => {
    const { target, documents, archives, access } = await fixture();
    warning.mockResolvedValue('許可');
    const uris = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const followed = Uri.file(join(dirname(uris.left.fsPath), 'lib.ts')) as vscode.Uri;
    const position = await workingPosition(
      textDocument(followed, 'export const value = 1;\n'),
      new vscode.Position(0, 0),
      documents,
      access,
    );
    // 同じ行の置換には対応先がないので、誤って展開先を作業ツリーと扱わない。
    expect(position).toHaveProperty('reason');
    await writeFile(join(target.repo, 'lib.ts'), 'export const value = 1;\n');
    const mapped = await workingPosition(
      textDocument(followed, 'export const value = 1;\n'),
      new vscode.Position(0, 0),
      documents,
      access,
    );
    expect(mapped).toMatchObject({ uri: Uri.file(join(target.repo, 'lib.ts')), position: new vscode.Position(0, 0) });
    const tree = FilesTree.register(documents, access, revisionSnapshots(access, new ChangedFiles(access)), archives);
    disposeAfter(tree);
    Object.assign(tree.view, { visible: true });
    await tree.synchronize();
    const root = (await tree.getChildren()).find((node) => node.kind === 'root' && node.side === 'old')!;
    const file = (await tree.getChildren(root)).find((node) => node.path === 'lib.ts')!;
    await tree.open(file);
    const opened = window.showTextDocument.mock.calls.at(-1)![0];
    expect(opened).toEqual(followed);
    expect((await documents.resolve(followed))?.file).toMatchObject({ path: 'lib.ts', status: 'M' });
  });
  it('無関係な文書を走査せず、展開先の編集だけコメント範囲を更新する', async () => {
    const { target, documents, access, context } = await fixture();
    warning.mockResolvedValue('許可');
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const service = new ReviewComments(context.workspaceState, () => undefined, documents, access, {
      review: () => undefined,
    });
    disposeAfter(service);
    rangeProviderAssigned.mockClear();
    await service.refreshDocument(textDocument(Uri.file('/unrelated') as vscode.Uri, 'typing'));
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    const original = await readFile(left.fsPath, 'utf8');
    const provider = controller.commentingRangeProvider!;
    const token = { isCancellationRequested: false } as vscode.CancellationToken;
    const before = await provider.provideCommentingRanges(textDocument(left, original), token);
    expect(before).toEqual([new vscode.Range(0, 0, 2, 0)]);
    const edited = textDocument(left, 'edited\nextra\nlines\n');
    await service.refreshDocument(edited);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
    expect(await controller.commentingRangeProvider!.provideCommentingRanges(edited, token)).toEqual([]);
  });
  it('削除失敗を通知しても開く操作の結果を返す', async () => {
    const { archives, target, git } = await fixture();
    warning.mockResolvedValue('許可');
    const first = (await archives.uri(revisionRef(target, 'old')))!;
    for (const value of [3, 4, 5]) {
      await writeFile(join(target.repo, 'lib.ts'), String(value));
      await commitAll(target.repo, String(value));
      const commit = (await git.log(0, 1))[0]!;
      await archives.uri(
        revisionRef(
          { ...target, commit, parent: await git.parent(commit), file: { path: 'lib.ts', status: 'M' } },
          'new',
        ),
      );
    }
    await rm(`${dirname(first.fsPath)}.complete`);
    await mkdir(`${dirname(first.fsPath)}.complete`);
    await utimes(`${dirname(first.fsPath)}.complete`, 1, 1);
    globalConfiguration.set('vsreview.revisionArchive.maxCount', 2);
    expect(await archives.withLease(() => Promise.resolve('opened'))).toBe('opened');
    await waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('EISDIR')));
  });
  it('入れ子と並行のリースが残る間は展開を削除しない', async () => {
    archiveClock();
    const { archives, target, git, documents, context, access } = await fixture();
    warning.mockResolvedValue('許可');
    globalConfiguration.set('vsreview.revisionArchive.maxCount', 2);
    const roots: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = archives.withLease(() => gate);
    await archives.withLease(async () => {
      for (const text of ['three', 'four', 'five']) {
        await writeFile(join(target.repo, 'lib.ts'), text);
        await commitAll(target.repo, text);
        const commit = (await git.log(0, 1))[0]!;
        const ref = revisionRef(
          { ...target, commit, parent: commit.parents[0]!, file: { path: 'lib.ts', status: 'M' } },
          'new',
        );
        const uri = (await archives.uri(ref))!;
        roots.push(dirname(uri.fsPath));
      }
      await archives.withLease(async () => {
        await archives.prune([]);
      });
    });
    await archives.prune([]);
    for (const root of roots) {
      await expect(lstat(root)).resolves.toBeDefined();
    }
    release();
    await held;
    await archives.prune([]);
    await expect(lstat(roots[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
    const forgotten = Uri.file(join(roots[0]!, 'lib.ts')) as vscode.Uri;
    expect(await archives.owns(forgotten)).toBe(false);
    expect(await documents.resolve(forgotten)).toBeUndefined();
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    expect(await restored.owns(forgotten)).toBe(false);
  });
  it('file URI の偽の ref クエリを旧側の識別に使わない', async () => {
    const { target, documents } = await fixture();
    const current = Uri.file(join(target.repo, 'lib.ts'));
    for (const ref of [
      'not json',
      JSON.stringify(revisionRef(target, 'old')),
      JSON.stringify(revisionRef(target, 'new')),
    ]) {
      const uri = Uri.from({
        scheme: 'file',
        path: current.path,
        query: new URLSearchParams({ ref }).toString(),
      }) as vscode.Uri;
      expect(await documents.resolve(uri)).toBeUndefined();
    }
  });
  it('同じ新リビジョンを共有しても、アクティブな PR の右側に解決する', async () => {
    const { target, documents } = await fixture();
    warning.mockResolvedValue('許可');
    await writeFile(join(target.repo, 'lib.ts'), 'working tree differs');
    const modified = { ...target, file: { path: 'lib.ts', status: 'M' as const } };
    await documents.diffUris(modified);
    const pr = { ...modified, pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent } };
    const pair = await documents.diffUris(pr);
    activateTab(new TabInputTextDiff(pair.left, pair.right));
    expect(await documents.resolve(pair.right)).toMatchObject({ side: 'new', pullRequest: { number: 12 } });
  });
});

describe('revisionArchiveDocuments の復元と失敗', () => {
  it.each(['expanded', 'working', 'virtual'])('再起動後に右側 %s と旧側の組から比較を復元する', async (kind) => {
    const { target, documents, archives, access, state, context, git } = await fixture();
    warning.mockResolvedValue('許可');
    const first = { ...target, file: { path: 'lib.ts', status: 'M' as const } };
    await documents.diffUris(first);
    await writeFile(join(target.repo, 'lib.ts'), 'third revision');
    await commitAll(target.repo, 'third');
    const comparison = { ...first, commit: (await git.log(0, 1))[0]! };
    if (kind !== 'working') {
      await writeFile(join(target.repo, 'lib.ts'), 'working differs');
    }
    const pair = await documents.diffUris(comparison);
    const right = kind === 'virtual' ? revisionUri(revisionRef(comparison, 'new'), 'new') : pair.right;
    // URI 対の保存がない旧バージョンの状態からも、両側の候補で復元する。
    await state.update('vsreview.archivePairs', undefined);
    activateTab(new TabInputTextDiff(pair.left, right));
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    const review = new ReviewDocuments(access, restored);
    expect(await review.openDiffRefs()).toMatchObject([
      { commit: { hash: comparison.commit.hash }, parent: target.parent },
    ]);
    expect((await review.resolve(pair.left))?.commit.hash).toBe(comparison.commit.hash);
    expect(await archives.owns(pair.left)).toBe(true);
  });
  it('保存した同一 URI 対の比較を再起動後も保持し、削除時に忘れる', async () => {
    const { target, documents, access, context } = await fixture();
    warning.mockResolvedValue('許可');
    const local = await documents.diffUris(target);
    const pr = { ...target, pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent } };
    const pair = await documents.diffUris(pr);
    expect(pair.left.toString()).toBe(local.left.toString());
    activateTab(new TabInputTextDiff(pair.left, pair.right));
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    await restored.owns(pair.left);
    expect((await new ReviewDocuments(access, restored).openDiffRefs())[0]?.pullRequest?.number).toBe(12);
    warning.mockResolvedValue('全削除');
    await restored.clear();
    expect(await new ReviewDocuments(access, restored).openDiffRefs()).toEqual([]);
  });
  it('初期化失敗を一度通知し、保存領域を直せば再試行する', async () => {
    const { target, access } = await fixture();
    const storage = await temporaryDirectory();
    await writeFile(join(storage, 'revisionArchives'), 'blocked');
    const context = extensionContext(new KeyedState(), { storageUri: vscode.Uri.file(storage) });
    const archives = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    await archives.prune().catch((error: unknown) => archives.reportFailure(error));
    await archives.prune().catch((error: unknown) => archives.reportFailure(error));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    await rm(join(storage, 'revisionArchives'));
    warning.mockResolvedValue('許可');
    const uri = await archives.uri(revisionRef(target, 'old'));
    expect(uri?.scheme).toBe('file');
    expect(await readFile(uri!.fsPath, 'utf8')).toContain('import');
  });
  it('開いた展開ファイルが消えたら実ソースとして使わずコメントを拒否する', async () => {
    const { target, archives, documents } = await fixture();
    warning.mockResolvedValue('許可');
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = textDocument(left, await readFile(left.fsPath, 'utf8'));
    await rm(left.fsPath);
    expect(await archives.isSource(left)).toBe(false);
    await expect(documents.assertCommentable(doc)).rejects.toThrow('展開したリビジョンの内容が変わりました');
  });
  it('リポジトリの許可とは別に外部 PR の head を PR ごとに確認する', async () => {
    const { target, archives, documents } = await fixture();
    warning.mockResolvedValue('許可');
    const modified = { ...target, file: { path: 'lib.ts', status: 'M' as const } };
    await documents.diffUris(modified);
    await writeFile(join(target.repo, 'lib.ts'), 'working differs');
    warning.mockClear();
    for (const number of [12, 13]) {
      const ref = revisionRef(
        {
          ...modified,
          pullRequest: { number, headRefOid: target.commit.hash, mergeBase: target.parent, isCrossRepository: true },
        },
        'new',
      );
      expect((await archives.uri(ref))?.scheme).toBe('file');
      expect((await archives.uri(ref))?.scheme).toBe('file');
    }
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenNthCalledWith(1, expect.stringContaining('外部 PR #12'), { modal: true }, '許可', '拒否');
    expect(warning).toHaveBeenNthCalledWith(2, expect.stringContaining('外部 PR #13'), { modal: true }, '許可', '拒否');
  });
});

describe('revisionArchiveDocuments の準備', () => {
  it('復元直後の所有と参照の問い合わせで内部の準備を済ませる', async () => {
    const { target, documents, access, context } = await fixture();
    warning.mockResolvedValue('許可');
    const pair = await documents.diffUris(target);
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    expect(await restored.owns(pair.left)).toBe(true);
    expect(await restored.refs(pair.left)).toMatchObject([{ path: 'deleted.ts', side: 'old', file: { status: 'D' } }]);
  });
  it('リンク配下のファイルを展開文書として返さない', async () => {
    const { target, archives } = await fixture();
    warning.mockResolvedValue('許可');
    await mkdir(join(target.repo, 'node_modules'));
    await writeFile(join(target.repo, 'node_modules/x.ts'), 'local dependency');
    const ref = revisionRef({ ...target, file: { path: 'node_modules/x.ts', status: 'M' } }, 'old');
    expect(await archives.uri(ref)).toBeUndefined();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it('復元に失敗する比較があっても他の比較を準備し、同じ失敗は通知し直さない', async () => {
    const { target, documents, archives, state, context, access } = await fixture();
    warning.mockResolvedValue('許可');
    const pair = await documents.diffUris(target);
    const saved = state.get<unknown[]>('vsreview.archiveContexts')!;
    const broken = revisionRef({ ...target, commit: { ...target.commit, hash: 'f'.repeat(40) } }, 'old');
    await state.update('vsreview.archiveContexts', [broken, ...saved]);
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    await restored.owns(pair.left);
    expect(await restored.refs(pair.left)).toMatchObject([{ commit: { hash: target.commit.hash } }]);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    await restored.owns(pair.left);
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(await archives.owns(pair.left)).toBe(true);
  });
  it.each([true, false])('変更された展開文書（dirty=%s）は行対応へ進まない', async (dirty) => {
    const { target, documents, access } = await fixture();
    warning.mockResolvedValue('許可');
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const processes = gitProcesses();
    const result = await workingPosition(
      textDocument(left, 'inserted\nchanged', dirty),
      new vscode.Position(1, 0),
      documents,
      access,
    );
    expect(result).toEqual({ reason: '展開したリビジョンの内容が変わりました。差分を開き直してください' });
    expect(processes.mock.calls.some((call) => (call[1] as string[]).includes('--no-index'))).toBe(false);
  });
  it.each([false, undefined, true])('外部 PR 判定 %j と拒否を展開に反映する', async (isCrossRepository) => {
    const { target, archives } = await fixture();
    const ref = revisionRef(
      {
        ...target,
        file: { path: 'lib.ts', status: 'M' },
        pullRequest: {
          number: 42,
          headRefOid: target.commit.hash,
          mergeBase: target.parent,
          ...(isCrossRepository === undefined ? {} : { isCrossRepository }),
        },
      },
      'new',
    );
    warning.mockResolvedValueOnce('許可').mockResolvedValue('拒否');
    const uri = await archives.uri(ref);
    expect(uri?.scheme).toBe(isCrossRepository === false ? 'file' : undefined);
    expect(warning).toHaveBeenCalledTimes(isCrossRepository === false ? 1 : 2);
  });
  it('展開先のクエリ付き URI は所有しても参照として解決しない', async () => {
    const { target, archives, documents } = await fixture();
    warning.mockResolvedValue('許可');
    const { left } = await documents.diffUris(target);
    const queried = Uri.from({ scheme: 'file', path: left.path, query: 'ref=forged' }) as vscode.Uri;
    expect(await archives.owns(queried)).toBe(true);
    expect(await archives.refs(queried)).toEqual([]);
    expect(await documents.resolve(queried)).toBeUndefined();
  });
  it('失敗通知は短時間だけまとめ、再試行時には再通知する', async () => {
    const { archives } = await fixture();
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    archives.reportFailure(new Error('retry failure'));
    archives.reportFailure(new Error('retry failure'));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    time.mockReturnValue(now + 5000);
    archives.reportFailure(new Error('retry failure'));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
  });
  it('不正な保存 URI 対を比較の復元に使わず、リンク情報は完了情報で再検証する', async () => {
    const { target, documents, access, state, context } = await fixture();
    warning.mockResolvedValue('許可');
    const modified = { ...target, file: { path: 'lib.ts', status: 'M' as const } };
    const { left, right } = await documents.diffUris(modified);
    const ref = revisionRef(modified, 'old');
    const pr = { ...modified, pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent } };
    await documents.diffUris(pr);
    const key = JSON.stringify([left.toString(), right.toString()]);
    for (const pairs of [
      null,
      'bad',
      [[key]],
      [[42, ref]],
      [[key, ref, 'extra']],
      [[key, { ...ref, rev: 'invalid' }]],
      [[key, { ...ref, repo: '/unknown' }]],
    ]) {
      await state.update('vsreview.archivePairs', pairs);
      const saved = state.get<object[]>('vsreview.archiveContexts')!;
      await state.update(
        'vsreview.archiveContexts',
        saved.map((value) => ({ ...value, archiveLinks: ['lib.ts'] })),
      );
      const restored = RevisionArchives.create(
        context,
        access,
        new RevisionSnapshots(access, new ChangedFiles(access)),
      );
      // 二つの比較が同じ URI 対を使うので、不正な保存対が選択を決めてはならない。
      expect(await restored.pairRef(left, right)).toBeUndefined();
      expect(await restored.isSource(left)).toBe(true);
      activateTab(new TabInputTextDiff(left, right));
      expect(await new ReviewDocuments(access, restored).openDiffRefs()).toEqual([]);
    }
    await state.update('vsreview.archivePairs', [[key, revisionRef(pr, 'old')]]);
    const restored = RevisionArchives.create(context, access, new RevisionSnapshots(access, new ChangedFiles(access)));
    expect((await restored.pairRef(left, right))?.pullRequest?.number).toBe(12);
  });
  it('展開先の通常タブを開いたまま、別の通常タブへ移っても Files の選択を保つ', async () => {
    const { target, documents, archives, access } = await fixture();
    warning.mockResolvedValue('許可');
    const pair = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(pair.left, pair.right));
    const followed = vscode.Uri.file(join(dirname(pair.left.fsPath), 'lib.ts'));
    const tree = FilesTree.register(documents, access, revisionSnapshots(access, new ChangedFiles(access)), archives);
    disposeAfter(tree);
    Object.assign(tree.view, { visible: true });
    activateTab(new TabInputText(followed));
    const normal = window.tabGroups.activeTabGroup.activeTab!;
    window.activeTextEditor = { document: textDocument(followed, 'export const value = 1;\n') } as vscode.TextEditor;
    await tree.synchronize();
    const root = (await tree.getChildren()).find((node) => node.kind === 'root' && node.side === 'old')!;
    const lib = (await tree.getChildren(root)).find((node) => node.path === 'lib.ts')!;
    expect(tree.getTreeItem(lib).description).toContain('開いているファイル');
    activateTab(new TabInputText(vscode.Uri.file('/unrelated')));
    window.tabGroups.activeTabGroup.tabs.unshift(normal);
    window.activeTextEditor = { document: textDocument(vscode.Uri.file('/unrelated'), '') } as vscode.TextEditor;
    await tree.synchronize();
    expect(tree.getTreeItem(lib).description).toContain('開いているファイル');
  });
});
