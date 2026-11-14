import {
  archiveLease,
  reviewDocuments,
  pullRequestRepository,
  disposeAfter,
  unexpectedGh,
  repository,
  accessFor,
  reviewComment,
} from './fixtures';
import { targetFromComment } from '../src/core/documents';
import { ChangedFiles } from '../src/ui/repositories';
import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { writeFile, unlink, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../src/git/client';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { ReviewDiff } from '../src/ui/diff';
import { shortHash } from '../src/core/presentation';
import { createUncommittedChanges } from '../src/git/uncommitted';
import { revisionUri, RevisionProvider } from '../src/ui/revisions';
import {
  commands,
  globalConfiguration,
  window,
  workspace,
  docs,
  textDocument,
  Selection,
  Position,
  TextEditorRevealType,
} from './vscodeMock';

describe('diff', () => {
  it.each(['snapshot', 'unstaged parent', 'staged parent'] as const)(
    '未コミットの%s消失を説明し、差分を開かない',
    async (missing) => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'a'), 'base');
      await commitAll(directory, 'base');
      await writeFile(join(directory, 'a'), 'staged');
      await runGit(directory, ['add', 'a']);
      await writeFile(join(directory, 'a'), 'working');
      const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
      const kind = missing === 'staged parent' ? 'staged' : 'unstaged';
      const change = changes[kind];
      const hash = missing === 'snapshot' ? change.commit.hash : change.parent;
      const { commonDir } = await git.directories();
      await rm(join(commonDir, 'objects', hash.slice(0, 2), hash.slice(2)));
      const access = await accessFor(directory);
      const diff = new ReviewDiff(
        reviewDocuments(access),
        access,
        new ChangedFiles(access),
        { gh: unexpectedGh, remote: () => 'origin' },
        { review: () => undefined },
        archiveLease,
      );
      await diff.openDiff({
        repo: directory,
        ...change,
        file: change.files[0]!,
        uncommitted: { kind, ...(changes.head ? { head: changes.head } : {}), createdAt: changes.createdAt },
      });
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('スナップショットのオブジェクトが見つからない'),
      );
      expect(commands.executeCommand.mock.calls.some(([name]) => name === 'vscode.diff')).toBe(false);
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    },
  );
  it.each(['rename', 'delete'])('未コミットの%sを旧パスと空の側を保って開く', async (operation) => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'old'), 'original');
    await commitAll(directory, 'base');
    if (operation === 'rename') {
      await rename(join(directory, 'old'), join(directory, 'new'));
    } else {
      await unlink(join(directory, 'old'));
    }
    const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const target = {
      repo: directory,
      ...changes.unstaged,
      file: changes.unstaged.files[0]!,
      uncommitted: { kind: 'unstaged' as const, createdAt: changes.createdAt },
    };
    const access = await accessFor(directory);
    disposeAfter(workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)));
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    await diff.openDiff(target);
    const call = commands.executeCommand.mock.calls.find(([name]) => name === 'vscode.diff')!;
    expect((await workspace.openTextDocument(call[1] as vscode.Uri)).getText()).toBe('original');
    expect((await workspace.openTextDocument(call[2] as vscode.Uri)).getText()).toBe(
      operation === 'rename' ? 'original' : '',
    );
    expect(target.file).toEqual(
      operation === 'rename' ? { path: 'new', oldPath: 'old', status: 'R' } : { path: 'old', status: 'D' },
    );
  });
  it('初回コミット前と未追跡の左側は空で、移動は同じスナップショットに留まる', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'staged');
    await runGit(directory, ['add', 'a']);
    await writeFile(join(directory, 'b'), 'untracked b');
    await writeFile(join(directory, 'c'), 'untracked c');
    const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const access = await accessFor(directory);
    disposeAfter(workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)));
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    for (const change of [changes.staged, changes.unstaged]) {
      const target = {
        repo: directory,
        ...change,
        file: change.files[0]!,
        uncommitted: { kind: change.kind, createdAt: changes.createdAt },
      };
      await diff.openDiff(target);
      const call = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
      expect((await workspace.openTextDocument(call[1] as vscode.Uri)).getText()).toBe('');
      expect((await workspace.openTextDocument(call[2] as vscode.Uri)).getText()).toBe(
        change.kind === 'staged' ? 'staged' : 'untracked b',
      );
      if (change.kind === 'unstaged') {
        await writeFile(join(directory, 'c'), 'later');
        await diff.openAdjacentDiff(1, call[2]);
        const adjacent = commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)!;
        expect((await workspace.openTextDocument(adjacent[2] as vscode.Uri)).getText()).toBe('untracked c');
        await diff.openAdjacentDiff(1, adjacent[2]);
        expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: この方向にファイルはありません', 5000);
      }
    }
  });
  it('保存 PR コメントから gh を使わずオブジェクトを復元して差分を開く', async () => {
    const { git, directory, saved } = await pullRequestRepository();
    const access = await accessFor(directory, () => git);
    disposeAfter(workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access)));
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    expect(await git.hasCommit(saved.commit)).toBe(false);
    await diff.openDiff(targetFromComment(saved), saved);
    expect(await git.hasCommit(saved.commit)).toBe(true);
    expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toHaveLength(1);
  });
  it('保存比較を復元できなければ差分を開かない', async () => {
    const { git, directory, saved } = await pullRequestRepository();
    const access = await accessFor(directory, () => git);
    vi.spyOn(git, 'fetch').mockRejectedValue(new Error('fetch failed'));
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    await expect(diff.openDiff(targetFromComment(saved), saved)).rejects.toThrow(
      '保存した PR の head を取得できません: fetch failed',
    );
    expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toEqual([]);
  });

  it('表示切り替え後もツリーの深さ優先順・一覧の順で前後へ移動する', async () => {
    const { directory, git } = await repository();
    await mkdir(join(directory, 'z/deep'), { recursive: true });
    for (const path of ['a', 'z/deep/b', 'z/deep/c']) {
      await writeFile(join(directory, path), path);
    }
    await commitAll(directory, 'files');
    const commit = (await git.log(0, 1))[0]!;
    const access = await accessFor(directory);
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    const openedTitle = () => commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff').at(-1)?.[3];
    const target = {
      repo: directory,
      commit,
      parent: await git.parent(commit),
      file: { path: 'z/deep/c', status: 'A' as const },
    };
    await diff.openAdjacentDiff(1, target);
    expect(openedTitle()).toBe(`a (${shortHash(commit.hash)})`);
    globalConfiguration.set('vsreview.fileView', 'list');
    await diff.openAdjacentDiff(-1, { ...target, file: { ...target.file, path: 'z/deep/b' } });
    expect(openedTitle()).toBe(`a (${shortHash(commit.hash)})`);
    globalConfiguration.set('vsreview.fileView', 'tree');
    await diff.openAdjacentDiff(-1, { ...target, file: { ...target.file, path: 'a' } });
    expect(openedTitle()).toBe(`z/deep/c (${shortHash(commit.hash)})`);
    commands.executeCommand.mockClear();
    await diff.openAdjacentDiff(1, { ...target, file: { ...target.file, path: 'a' } });
    await diff.openAdjacentDiff(-1, { ...target, file: { ...target.file, path: 'z/deep/b' } });
    globalConfiguration.set('vsreview.fileView', 'list');
    await diff.openAdjacentDiff(-1, { ...target, file: { ...target.file, path: 'a' } });
    await diff.openAdjacentDiff(1, target);
    for (const offset of [-1, 1]) {
      await diff.openAdjacentDiff(offset, { ...target, file: { ...target.file, path: 'absent' } });
    }
    expect(commands.executeCommand.mock.calls.filter(([name]) => name === 'vscode.diff')).toEqual([]);
  });
  it('古い側の行を右側のselectionに渡さず、左右のフォーカスを選ぶ', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'a\nb');
    await commitAll(directory, 'one');
    const parent = (await git.log(0, 10))[0]!.hash;
    await writeFile(join(directory, 'a'), 'a\nB');
    await commitAll(directory, 'two');
    const commit = (await git.log(0, 10))[0]!;
    const target = { repo: directory, parent, commit, file: { path: 'a', status: 'M' as const } };
    const access = await accessFor(directory);
    const diff = new ReviewDiff(
      reviewDocuments(access),
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    workspace.registerTextDocumentContentProvider('vsreview', new RevisionProvider(access));
    const left = revisionUri(target, 'old');
    docs.push(textDocument(left, 'a\nb'));
    const reveal = vi.fn();
    const editor = {
      document: docs[0],
      selection: new Selection(new Position(0, 0), new Position(0, 0)),
      revealRange: reveal,
    } as unknown as vscode.TextEditor;
    window.activeTextEditor = editor;
    await diff.openDiff(target, { ...reviewComment, side: 'old', startLine: 2, endLine: 2 });
    const old = commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')!;
    expect(old[4]).not.toHaveProperty('selection');
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.focusSecondarySide');
    expect(editor.selection).toEqual(new Selection(new Position(1, 0), new Position(1, 1)));
    expect(reveal).toHaveBeenCalledWith(
      expect.objectContaining({ start: new Position(1, 0), end: new Position(1, 1) }),
      TextEditorRevealType.InCenter,
    );
    commands.executeCommand.mockClear();
    window.activeTextEditor = {
      ...editor,
      document: await workspace.openTextDocument((await reviewDocuments(access).diffUris(target)).right),
    };
    await diff.openDiff(target, { ...reviewComment, side: 'new', startLine: 2, endLine: 2 });
    expect(commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')?.[4]).toHaveProperty(
      'selection',
    );
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.compareEditor.focusPrimarySide');
    expect(window.activeTextEditor?.selection).toEqual(new Selection(new Position(1, 0), new Position(1, 1)));
    expect(reveal).toHaveBeenCalledTimes(2);
    commands.executeCommand.mockClear();
    await diff.openDiff(target, { ...reviewComment, side: 'file' });
    expect(commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')?.[4]).toEqual({
      preview: true,
    });
    expect(reveal).toHaveBeenCalledTimes(2);
  });
  it('ファイル移動の先頭・末尾・一覧外は差分を開かず、バイナリも通知に留める', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'a');
    await writeFile(join(directory, 'b'), 'b');
    await writeFile(join(directory, 'binary'), Buffer.from([0]));
    await commitAll(directory, 'one');
    const commit = (await git.log(0, 10))[0]!;
    const parent = await git.parent(commit);
    const access = await accessFor(directory);
    const documents = reviewDocuments(access);
    const diff = new ReviewDiff(
      documents,
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    const target = { repo: directory, parent, commit, file: { path: 'a', status: 'A' as const } };
    await diff.openAdjacentDiff(-1, target);
    await diff.openAdjacentDiff(1, { ...target, file: { ...target.file, path: 'not-listed' } });
    await diff.openAdjacentDiff(1, { ...target, file: { ...target.file, path: 'binary' } });
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(window.setStatusBarMessage).toHaveBeenCalledTimes(3);
    await diff.openDiff({ ...target, file: { path: 'binary', status: 'A' } });
    expect(window.showInformationMessage).toHaveBeenCalledWith('VSReview: バイナリファイルの差分は表示できません');
    await diff.openAdjacentDiff(1, target);
    expect(commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')?.[3]).toContain('b (');
  });

  it('削除ファイルの右側は空文書にし、gitlinkは案内だけ表示する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'before');
    await commitAll(directory, 'before');
    const parent = (await git.head())!;
    await unlink(join(directory, 'file'));
    await commitAll(directory, 'deleted');
    const commit = (await git.log(0, 1))[0]!;
    const access = await accessFor(directory);
    const documents = reviewDocuments(access);
    const diff = new ReviewDiff(
      documents,
      access,
      new ChangedFiles(access),
      { gh: unexpectedGh, remote: () => 'origin' },
      { review: () => undefined },
      archiveLease,
    );
    const target = { repo: directory, parent, commit, file: { status: 'D' as const, path: 'file' } };
    await diff.openDiff(target);
    const right = commands.executeCommand.mock.calls.find((args) => args[0] === 'vscode.diff')![2] as vscode.Uri;
    expect(right.scheme).toBe('vsreview');
    expect(await new RevisionProvider(access).provideTextDocumentContent(right)).toBe('');
    await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${parent},sub`]);
    await gitAsAuthor(directory, ['commit', '-m', 'gitlink']);
    const sub = (await git.log(0, 1))[0]!;
    commands.executeCommand.mockClear();
    await diff.openDiff({ repo: directory, parent: sub.hash, commit: sub, file: { status: 'D', path: 'sub' } });
    expect(commands.executeCommand).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith('VSReview: サブモジュールの差分は表示できません');
    await diff.openDiff({ repo: directory, parent: commit.hash, commit: sub, file: { status: 'A', path: 'sub' } });
    expect(commands.executeCommand).not.toHaveBeenCalled();
    expect(window.showInformationMessage).toHaveBeenCalledWith('VSReview: サブモジュールの差分は表示できません');
  });
});
