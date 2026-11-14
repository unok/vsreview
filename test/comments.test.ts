import { showError } from '../src/ui/common';
import {
  reviewDocuments,
  pullRequestReview,
  disposeAfter,
  repository,
  reviewComment,
  MemoryState,
  accessFor,
  gitProcesses,
} from './fixtures';
import type * as vscode from 'vscode';
import type { RepositoryAccess } from '../src/ui/repositories';
import type { FileTarget } from '../src/core/documents';
import {
  window,
  cancellationToken,
  Uri,
  Range,
  CommentMode,
  CommentThreadState,
  controller,
  rangeProviderAssigned,
  hiddenRangeDocuments,
  settleRangeRequests,
  disposedThreads,
  threads,
  docs,
  workspace,
  input,
  warning,
  documentOpened,
  documentClosed,
  activateTab,
  TabInputTextDiff,
  TabInputText,
  textDocument,
} from './vscodeMock';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { GitClient } from '../src/git/client';
import { ReviewDocuments, WORKING_TREE_MISMATCH } from '../src/ui/documents';
import { shortHash } from '../src/core/presentation';
import { ReviewComments } from '../src/ui/comments';
import { revisionUri, RevisionProvider } from '../src/ui/revisions';
import { serialize, deserialize, type ReviewComment } from '../src/core/model';
import { createUncommittedChanges } from '../src/git/uncommitted';

// 再登録の有無を使う既存ケースは、モックが持たない VS Code 所有の入力欄の再生成を検出するため。
// 実際の未保存本文とフォーカスの保持は E2E で検証し、競合ケースは再問い合わせを入口で観測する。
describe('comments', () => {
  it('未コミットの左右の範囲とファイルコメントを保存し、編集・解決・削除でも対象を保持する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a'), 'one\ntwo\nthree\n');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'a'), 'ONE\ntwo\nTHREE\n');
    const changes = await createUncommittedChanges(git, '2026-11-14T00:00:00Z');
    const target = {
      repo: directory,
      ...changes.unstaged,
      file: changes.unstaged.files[0]!,
      uncommitted: {
        kind: 'unstaged' as const,
        ...(changes.head ? { head: changes.head } : {}),
        createdAt: changes.createdAt,
      },
    };
    const access = await accessFor(directory);
    const state = new MemoryState();
    const service = new ReviewComments(state, () => {}, reviewDocuments(access), access, { review: () => undefined });
    disposeAfter(service);
    const provider = new RevisionProvider(access);
    for (const [side, range] of [
      ['new', new Range(2, 0, 2, 5)],
      ['old', new Range(0, 0, 1, 3)],
    ] as const) {
      const uri = revisionUri(target, side);
      const doc = textDocument(uri, await provider.provideTextDocumentContent(uri));
      docs.push(doc);
      await service.addRangeComment({
        thread: controller.createCommentThread(uri, range as vscode.Range, []),
        text: side,
      });
    }
    input.mockResolvedValueOnce('file');
    await service.addFileComment(target);
    expect(service.all.map((c) => [c.side, c.startLine, c.endLine])).toEqual([
      ['new', 3, 3],
      ['old', 1, 2],
      ['file', 0, 0],
    ]);
    for (const c of deserialize(state.value)) {
      expect(c).toMatchObject({
        uncommitted: target.uncommitted,
        subject: '未コミットの変更（未ステージ）',
        author: '',
        date: changes.createdAt,
      });
    }
    expect(service.all[0]?.excerpt).toContain('THREE');
    expect(threads.some((t) => t.label?.startsWith('未コミットの変更（未ステージ）'))).toBe(true);
    const first = service.all[0]!;
    await service.save({ id: first.id, body: 'edited' });
    await service.toggle(first);
    expect(service.all[0]).toMatchObject({ body: 'edited', resolved: true, uncommitted: target.uncommitted });
    await service.delete(first);
    expect(service.all.map((c) => c.side)).toEqual(['old', 'file']);
    for (const body of [undefined, '   ']) {
      input.mockResolvedValueOnce(body);
      await service.addFileComment(target);
    }
    expect(service.all).toHaveLength(2);
  });
  let target: FileTarget;
  let documents: ReviewDocuments;
  let access: RepositoryAccess;
  let saved: ReviewComment;
  let state: MemoryState;
  beforeEach(async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'main.ts'), 'a\nb\nc');
    await commitAll(directory, 'before');
    await writeFile(join(directory, 'main.ts'), 'a\nB\nc');
    await commitAll(directory, 'after');
    const commit = (await git.log(0, 10))[0]!;
    target = { repo: directory, commit, parent: await git.parent(commit), file: { path: 'main.ts', status: 'M' } };
    access = await accessFor(directory);
    documents = reviewDocuments(access);
    saved = {
      ...reviewComment,
      repoRoot: directory,
      commit: commit.hash,
      parent: target.parent,
      path: 'main.ts',
      status: 'M',
      side: 'old',
      startLine: 2,
      endLine: 2,
      body: 'original',
    };
    delete saved.oldPath;
    state = new MemoryState();
    state.value = serialize([saved]);
  });
  async function open(side: 'old' | 'new'): Promise<vscode.TextDocument> {
    const uri = revisionUri(target, side);
    const provider = new RevisionProvider(access);
    const doc = textDocument(uri, await provider.provideTextDocumentContent(uri));
    docs.push(doc);
    await documentOpened.fireAsync(doc);
    return doc;
  }
  function reply(doc: vscode.TextDocument, text: string, range = new Range(1, 0, 1, 1)): vscode.CommentReply {
    return { thread: controller.createCommentThread(doc.uri, range as vscode.Range, []), text };
  }
  it('解決待ちの再描画と削除が重なってもスレッドを復活させない', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    await open('old');
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resolve = documents.resolve.bind(documents);
    vi.spyOn(documents, 'resolve').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return resolve(...args);
    });
    const refresh = service.refresh();
    await started;
    const deletion = service.delete({ id: saved.id });
    const timer = setTimeout(release, 20);
    await deletion;
    release();
    await refresh;
    clearTimeout(timer);
    expect(service.all).toEqual([]);
    expect(threads.filter((thread) => !disposedThreads.has(thread))).toEqual([]);
  });
  it('明示的な refresh なしで初期スレッドを復元し、範囲を再問い合わせしない', async () => {
    await open('old');
    rangeProviderAssigned.mockClear();
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await vi.waitFor(() => expect(threads.some((thread) => thread.comments[0]?.body === 'original')).toBe(true));
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
  });
  it('初期描画と文書を開いたときの失敗を通知する', async () => {
    vi.spyOn(documents, 'openDiffs').mockRejectedValue(new Error('resolve failed'));
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: resolve failed'));
    window.showErrorMessage.mockClear();
    await open('old');
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: resolve failed'));
  });
  it('復元・編集中の保持・保存・取り消し・解決・削除を公開操作で確認する', async () => {
    const changed = vi.fn();
    const service = new ReviewComments(state, changed, documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await open('old');
    const thread = threads[0]!;
    expect(thread.comments[0]?.body).toBe('original');
    expect(thread.range.start.line).toBe(1);
    await service.edit(thread.comments[0]);
    expect(thread.comments[0]?.mode).toBe(CommentMode.Editing);
    await service.refresh();
    await open('new');
    expect(disposedThreads.has(thread)).toBe(false);
    expect(thread.comments[0]?.mode).toBe(CommentMode.Editing);
    await service.save({ id: saved.id, body: 'edited' });
    expect(service.all[0]?.body).toBe('edited');
    expect(thread.comments[0]?.body).toBe('edited');
    expect(thread.comments[0]?.mode).toBe(CommentMode.Preview);
    await service.edit(thread.comments[0]);
    service.cancelEdit(thread.comments[0]);
    expect(thread.comments[0]?.mode).toBe(CommentMode.Preview);
    await service.toggle(thread);
    expect(service.all[0]?.resolved).toBe(true);
    expect(thread.label).toContain('解決済み');
    expect(thread.state).toBe(CommentThreadState.Resolved);
    await service.delete(thread);
    expect(service.all).toEqual([]);
    expect(disposedThreads.has(thread)).toBe(true);
    expect(changed).toHaveBeenCalledTimes(3);
  });
  it('編集中でも解決状態とラベルを更新し、本文の入力を保つ', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await open('old');
    const thread = threads[0]!;
    await service.edit(thread.comments[0]);
    await service.toggle(thread);
    expect(thread.state).toBe(CommentThreadState.Resolved);
    expect(thread.label).toContain('解決済み');
    expect(thread.comments[0]).toMatchObject({ body: 'original', mode: CommentMode.Editing });
  });
  it('次行の 0 桁で終わる選択はその次行をアンカーに含めない', async () => {
    state.value = undefined;
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('old');
    const inputReply = reply(doc, '指摘', new Range(1, 0, 2, 0));
    await service.addRangeComment(inputReply);
    expect(disposedThreads.has(inputReply.thread)).toBe(true);
    expect(service.all[0]).toMatchObject({ side: 'old', startLine: 2, endLine: 2, code: 'b', body: '指摘' });
    expect(service.all[0]?.excerpt).toContain('> -b');
    expect(service.all[0]?.excerpt).not.toContain('>  c');
  });
  it('通常タブへの切り替え・未保存編集では実ファイルへのコメントを許可しない', async () => {
    state.value = undefined;
    const uris = await documents.diffUris(target);
    expect(uris.right.scheme).toBe('file');
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const doc = await workspace.openTextDocument(uris.right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await service.addRangeComment(reply(doc, 'new側'));
    expect(service.all[0]?.side).toBe('new');
    const count = threads.length;
    activateTab(new TabInputText(uris.right));
    await service.refresh();
    expect(threads.slice(0, count).every((t) => disposedThreads.has(t))).toBe(true);
    await expect(service.addRangeComment(reply(doc, '通常タブ'))).rejects.toThrow(
      'この文書にはコメントを追加できません',
    );
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const dirty = textDocument(uris.right, 'edited', true);
    docs.splice(docs.indexOf(doc), 1, dirty);
    await expect(service.addRangeComment(reply(dirty, '変更後'))).rejects.toThrow(WORKING_TREE_MISMATCH);
    await expect(service.addFileComment(target, dirty)).rejects.toThrow(WORKING_TREE_MISMATCH);
  });
  it('差分構成と通常タブの併存が変わったときだけ範囲を更新する', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const provider = controller.commentingRangeProvider!;
    rangeProviderAssigned.mockClear();
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    const group = window.tabGroups.activeTabGroup;
    const diff = group.activeTab!;
    const unrelated = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
    group.tabs.push(unrelated);
    group.activeTab = unrelated;
    group.tabs.reverse();
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    const normal = { input: new TabInputText(right) };
    group.tabs.push(normal);
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toEqual([]);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
    group.tabs.splice(group.tabs.indexOf(normal), 1);
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(2);
    group.tabs.splice(group.tabs.indexOf(diff), 1);
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toEqual([]);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(3);
  });

  // モックには VS Code 所有の未保存コメント文書がないため、ここでは再登録を観測する。
  // 本文の保持・追記・保存は e2e/index.ts の draft / editing の左右切替で確認する。
  it('古い差分の一覧で更新しても、新しいPR側で問い合わせ済みなら再登録しない', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    const stale = await documents.openDiffs();
    const pr = { ...target, pullRequest: { number: 12, headRefOid: target.commit.hash, mergeBase: target.parent } };
    activateTab(new TabInputTextDiff(revisionUri(pr, 'old'), right));
    expect((await documents.resolve(right))?.pullRequest?.number).toBe(12);
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    rangeProviderAssigned.mockClear();
    await service.refresh({ diffs: stale });
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
  });

  it('非表示文書への再問い合わせが保留されても同じ差を繰り返し通知しない', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const doc = textDocument(revisionUri(target, 'new'), 'after');
    docs.push(doc, textDocument(Uri.file('/visible.ts') as vscode.Uri, 'visible'));
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(false);
    await controller.commentingRangeProvider!.provideCommentingRanges(doc, cancellationToken);
    hiddenRangeDocuments.add(doc.uri.toString());
    canComment.mockImplementation((document) => Promise.resolve(document === doc));
    await service.refresh();
    await settleRangeRequests();
    const queried = canComment.mock.calls.length;
    await service.refresh();
    await settleRangeRequests();
    // 非表示文書自身は refresh の判定だけを受け、表示中の文書への余計な再問い合わせを生まない。
    expect(canComment.mock.calls.length - queried).toBe(2);
    hiddenRangeDocuments.delete(doc.uri.toString());
    expect(await controller.commentingRangeProvider!.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
  });
  it('初回の古い範囲問い合わせ完了後にrefreshの可否判定との差を再問い合わせする', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const doc = textDocument(revisionUri(target, 'new'), 'after');
    docs.push(doc);
    let release!: (value: boolean) => void;
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(true);
    canComment.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const provider = controller.commentingRangeProvider!;
    const old = provider.provideCommentingRanges(doc, cancellationToken);
    await service.refresh();
    const queried = canComment.mock.calls.length;
    release(false);
    expect(await old).toEqual([]);
    await settleRangeRequests();
    expect(canComment.mock.calls.length - queried).toBe(1);
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
  });
  it('true→false→trueの途中で止まった問い合わせの完了後にも範囲を再問い合わせする', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const doc = textDocument(revisionUri(target, 'new'), 'after');
    docs.push(doc);
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(true);
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    let release!: (value: boolean) => void;
    canComment.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const intermediate = provider.provideCommentingRanges(doc, cancellationToken);
    await service.refresh();
    const queried = canComment.mock.calls.length;
    release(false);
    expect(await intermediate).toEqual([]);
    await settleRangeRequests();
    expect(canComment.mock.calls.length - queried).toBe(1);
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
  });
  it('refreshの可否判定中に文書が閉じたら範囲を再問い合わせしない', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const doc = textDocument(revisionUri(target, 'new'), 'after');
    docs.push(doc);
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(true);
    await controller.commentingRangeProvider!.provideCommentingRanges(doc, cancellationToken);
    let release!: (value: boolean) => void;
    canComment.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = service.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    Object.defineProperty(doc, 'isClosed', { value: true, configurable: true });
    const queried = canComment.mock.calls.length;
    release(false);
    await refresh;
    await documentClosed.fireAsync(doc);
    await settleRangeRequests();
    expect(canComment.mock.calls).toHaveLength(queried);
  });
  it('refreshの可否判定中に範囲を問い合わせ直したら、遅い判定で再登録しない', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    let release!: (value: boolean) => void;
    let entered = false;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    vi.spyOn(documents, 'isCommentable').mockImplementationOnce(() => {
      entered = true;
      return gate;
    });
    const refresh = service.refresh();
    await vi.waitFor(() => expect(entered, 'refreshの可否判定が始まる').toBe(true));
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    rangeProviderAssigned.mockClear();
    release(false);
    await refresh;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
  });

  it('古い範囲問い合わせが後で解決しても、新しい可否の記録を戻さない', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    await settleRangeRequests();
    const provider = controller.commentingRangeProvider!;
    let release!: (value: boolean) => void;
    vi.spyOn(documents, 'isCommentable').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const old = provider.provideCommentingRanges(doc, cancellationToken);
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    release(false);
    await old;
    rangeProviderAssigned.mockClear();
    await service.refresh();
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
  });

  it('キャンセル済み問い合わせの結果を記録せず、直前の可否を保つ', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    await settleRangeRequests();
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    vi.spyOn(documents, 'isCommentable').mockResolvedValueOnce(false);
    await provider.provideCommentingRanges(doc, { ...cancellationToken, isCancellationRequested: true });
    rangeProviderAssigned.mockClear();
    await service.refresh();
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
  });
  it.each([
    {
      name: 'missing-document',
      prepare: (doc: vscode.TextDocument): Promise<void> => {
        docs.splice(docs.indexOf(doc), 1);
        return Promise.resolve();
      },
      restore: (doc: vscode.TextDocument) => {
        docs.push(doc);
      },
    },
    {
      name: 'closed-flag',
      prepare: (doc: vscode.TextDocument): Promise<void> => {
        Object.defineProperty(doc, 'isClosed', { value: true, configurable: true });
        return Promise.resolve();
      },
      restore: (doc: vscode.TextDocument) => {
        Object.defineProperty(doc, 'isClosed', { value: false, configurable: true });
      },
    },
    {
      name: 'close-event',
      prepare: async (doc: vscode.TextDocument) => {
        await documentClosed.fireAsync(doc);
      },
      restore: () => {},
    },
  ])('閉じた文書の可否を除き、開き直した結果を使う: $name', async ({ prepare, restore }) => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    await settleRangeRequests();
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    await prepare(doc);
    rangeProviderAssigned.mockClear();
    await service.refresh();
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    restore(doc);
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(false);
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toEqual([]);
    await service.refresh();
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    canComment.mockResolvedValue(true);
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
  });
  it('別文書のrefreshの可否判定が失敗しても、次のrefreshで範囲の変更を通知する', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    const changed = textDocument(revisionUri(target, 'new'), 'after');
    const failed = textDocument(Uri.file('/failed.ts') as vscode.Uri, 'failed');
    docs.push(changed, failed);
    const canComment = vi.spyOn(documents, 'isCommentable').mockResolvedValue(false);
    const provider = controller.commentingRangeProvider!;
    await provider.provideCommentingRanges(changed, cancellationToken);
    await provider.provideCommentingRanges(failed, cancellationToken);
    canComment.mockImplementation((doc) =>
      doc === failed ? Promise.reject(new Error('failed document')) : Promise.resolve(true),
    );
    await expect(service.refresh()).rejects.toThrow('failed document');
    canComment.mockResolvedValue(true);
    const queried = canComment.mock.calls.length;
    await service.refresh();
    await settleRangeRequests();
    // 両文書への refresh 判定と、利用側の範囲再問い合わせを確認する。
    expect(canComment.mock.calls.length - queried).toBe(4);
  });
  it('refreshの可否判定失敗を呼び出し元へ返して通知でき、次の更新で復旧する', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    await service.refresh();
    await settleRangeRequests();
    const provider = controller.commentingRangeProvider!;
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    vi.spyOn(documents, 'isCommentable').mockRejectedValueOnce(new Error('refresh range failed'));
    // 拡張のイベントハンドラと同じエラー通知の入口を使う。
    await service.refresh().catch(showError);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: refresh range failed');
    rangeProviderAssigned.mockClear();
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
  });

  it('モックの範囲問い合わせの拒否を後始末までに回収する', async () => {
    const service = new ReviewComments(new MemoryState(), vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    docs.push(textDocument(revisionUri(target, 'old'), 'before'));
    vi.spyOn(documents, 'isCommentable').mockRejectedValue(new Error('range failure'));
    const provider = controller.commentingRangeProvider;
    controller.commentingRangeProvider = provider;
    await expect(settleRangeRequests()).rejects.toThrow('コメント範囲の問い合わせに失敗しました');
  });

  it('左側のレビュー文書だけ範囲を再問い合わせし、不正なレビューURIは無視する', async () => {
    const service = new ReviewComments(new MemoryState(), vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    rangeProviderAssigned.mockClear();
    await service.refreshDocument(textDocument(revisionUri(target, 'old'), 'before'));
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
    await service.refreshDocument(textDocument(Uri.from({ scheme: 'vsreview', path: '/invalid' }) as vscode.Uri, ''));
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
  });

  it('同じ作業ファイルの差分が複数ならアクティブな解決先の変更で範囲を再問い合わせする', async () => {
    await gitAsAuthor(target.repo, ['commit', '--allow-empty', '-m', 'same contents']);
    const git = access.client(target.repo);
    const commit = (await git.log(0, 1))[0]!;
    const second = { ...target, commit, parent: target.commit.hash };
    const right = Uri.file(join(target.repo, target.file.path)) as vscode.Uri;
    const doc = await workspace.openTextDocument(right);
    const firstTab = { input: new TabInputTextDiff(revisionUri(target, 'old'), right) };
    const secondTab = { input: new TabInputTextDiff(revisionUri(second, 'old'), right) };
    const unrelated = { input: new TabInputText(Uri.file('/unrelated') as vscode.Uri) };
    const group = window.tabGroups.activeTabGroup;
    group.tabs = [firstTab, secondTab, unrelated];
    group.activeTab = secondTab;
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const provider = controller.commentingRangeProvider!;
    rangeProviderAssigned.mockClear();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    group.activeTab = unrelated;
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toEqual([]);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(1);
    group.activeTab = firstTab;
    await service.refresh();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).toHaveBeenCalledTimes(2);
  });
  it('入力用文書は無視し、対象の編集・空バッファ・復元でスレッドとGitに触れず範囲を更新する', async () => {
    const { left, right } = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(left, right));
    const doc = await workspace.openTextDocument(right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const provider = controller.commentingRangeProvider!;
    rangeProviderAssigned.mockClear();
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    const git = gitProcesses();
    const draft = reply(doc, 'draft').thread;
    const created = threads.length;
    await service.refreshDocument(
      textDocument(Uri.from({ scheme: 'comment', path: '/input' }) as vscode.Uri, 'typing'),
    );
    expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(1);
    expect(rangeProviderAssigned).not.toHaveBeenCalled();
    const original = doc.getText();
    const text = vi.spyOn(doc, 'getText');
    for (const [index, content] of ['edited', '', original].entries()) {
      text.mockReturnValue(content);
      await service.refreshDocument(doc);
      expect(rangeProviderAssigned).toHaveBeenCalledTimes(index + 1);
      expect(await provider.provideCommentingRanges(doc, cancellationToken)).toHaveLength(content === original ? 1 : 0);
    }
    expect(threads).toHaveLength(created);
    expect(disposedThreads.has(draft)).toBe(false);
    expect(git).not.toHaveBeenCalled();
  });
  it('保存失敗時は元データと通知回数を保持し、同時更新は両方を残す', async () => {
    const changed = vi.fn();
    const service = new ReviewComments(state, changed, documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    state.fail = true;
    await expect(service.toggle(saved)).rejects.toThrow('disk full');
    expect(service.all[0]?.resolved).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await Promise.all([service.toggle(saved), service.save({ id: saved.id, body: 'changed' })]);
    expect(service.all[0]).toMatchObject({ body: 'changed', resolved: true });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(state.writes).toHaveLength(2);
  });
  it('ファイルコメントの追加・編集・キャンセル・空入力を処理する', async () => {
    state.value = undefined;
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    for (const value of [undefined, '  ']) {
      input.mockResolvedValueOnce(value);
      await service.addFileComment(target);
      expect(service.all).toEqual([]);
    }
    input.mockResolvedValueOnce('file note');
    await service.addFileComment(target);
    const comment = service.all[0]!;
    expect(comment).toMatchObject({ side: 'file', startLine: 0, endLine: 0 });
    input.mockResolvedValueOnce('edited');
    await service.edit({ kind: 'comment', comment });
    expect(service.all[0]?.body).toBe('edited');
    for (const value of [undefined, ' ']) {
      input.mockResolvedValueOnce(value);
      await service.edit({ kind: 'comment', comment });
      expect(service.all[0]?.body).toBe('edited');
    }
  });
  it('空本文・不正URI・未知IDでは保存しない', async () => {
    const original = structuredClone(saved);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await service.save({ id: saved.id, body: ' ' });
    expect(service.all.find((comment) => comment.id === saved.id)?.body).toBe(saved.body);
    await service.save({ id: 'unknown', body: 'bad' });
    await service.delete({});
    await service.toggle({});
    await service.edit({});
    const outside = textDocument(Uri.file('/outside') as vscode.Uri, 'text');
    await expect(service.addRangeComment(reply(outside, '指摘'))).rejects.toThrow(
      'この文書にはコメントを追加できません',
    );
    docs.push(outside);
    await expect(service.addRangeComment(reply(outside, '指摘'))).rejects.toThrow(
      'この文書にはコメントを追加できません',
    );
    await service.addRangeComment(reply(outside, '  '));
    expect(state.writes).toEqual([]);
    expect(service.all).toEqual([original]);
  });
  it('全削除と書き換え済み削除は確認後だけ保存する', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    warning.mockResolvedValueOnce(undefined);
    await service.clear();
    expect(service.all).toHaveLength(1);
    warning.mockResolvedValueOnce('削除');
    await service.clearRewritten((c) => c.commit === saved.commit);
    expect(service.all).toEqual([]);
    expect(state.writes).toHaveLength(1);
  });
  it.each([false, true])('書き換え済みの種類別件数を示し、確定した対象だけ削除する: PR=%s', async (withPr) => {
    const uncommitted = { ...saved, uncommitted: { kind: 'unstaged' as const, createdAt: saved.createdAt } };
    const values = [
      saved,
      { ...uncommitted, id: 'u1' },
      { ...uncommitted, id: 'u2' },
      { ...uncommitted, id: 'unchanged' },
      { ...saved, id: 'ordinary' },
      ...(withPr
        ? [
            {
              ...saved,
              id: 'pr',
              commit: pullRequestReview.headRefOid,
              parent: pullRequestReview.mergeBase,
              pullRequest: pullRequestReview,
            },
          ]
        : []),
    ];
    state.value = serialize(values);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    disposeAfter(service);
    warning.mockResolvedValueOnce('削除');
    await service.clearRewritten((c) => !['unchanged', 'ordinary'].includes(c.id));
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      `VSReview: 書き換え済みコミットのコメント 1 件、${withPr ? '書き換え済み PR のコメント 1 件、' : ''}内容が変更済みの未コミットのコメント 2 件を削除しますか？`,
      { modal: true },
      '削除',
    );
    expect(service.all.map((c) => c.id)).toEqual(['unchanged', 'ordinary']);
    expect(deserialize(state.value).map((c) => c.id)).toEqual(['unchanged', 'ordinary']);
  });
  it('文書を閉じるとスレッドを破棄し、再度開くと保存済み本文を復元する', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('old');
    const thread = threads[0]!;
    await documentClosed.fireAsync(doc);
    expect(disposedThreads.has(thread)).toBe(true);
    await documentOpened.fireAsync(doc);
    expect(threads.at(-1)?.comments[0]?.body).toBe(saved.body);
  });

  it('保存データの破損を拒否し、空側や範囲外のコメントは保存しない', async () => {
    state.value = { version: 9 };
    expect(() => new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined })).toThrow(
      '保存されたレビューコメントの形式が不正です',
    );
    state.value = undefined;
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('new');
    await expect(service.addRangeComment(reply(doc, '範囲外', new Range(99, 0, 99, 1)))).rejects.toThrow(
      'コメントの範囲がファイルの外です',
    );
    const targetAdded = { ...target, file: { path: 'main.ts', status: 'A' as const } };
    const empty = textDocument(revisionUri(targetAdded, 'old'), '');
    docs.push(empty);
    await expect(service.addRangeComment(reply(empty, '空側'))).rejects.toThrow('この文書にはコメントを追加できません');
    expect(state.writes).toEqual([]);
  });
  it('全削除は確定したときに全件を保存形式からも除く', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    warning.mockResolvedValueOnce('全削除');
    await service.clear();
    expect(service.all).toEqual([]);
    expect(state.value).toEqual({ version: 1, comments: [] });
  });

  it('不正なcancelEditは編集中のスレッドを変えず、範囲プロバイダは対象だけ返す', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('old');
    const thread = threads[0]!;
    await service.edit(thread);
    service.cancelEdit(undefined);
    expect(thread.comments[0]?.mode).toBe(CommentMode.Editing);
    const provider = controller.commentingRangeProvider!;
    const token = cancellationToken;
    expect(await provider.provideCommentingRanges(doc, token)).toEqual([new Range(0, 0, 2, 1)]);
    expect(
      await provider.provideCommentingRanges(textDocument(Uri.file('/outside') as vscode.Uri, 'x'), token),
    ).toEqual([]);
  });
  it('書き換え済み削除は該当なし・キャンセルでは保存せず、確認前のIDだけを消す', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await service.clearRewritten(() => false);
    expect(warning).not.toHaveBeenCalled();
    warning.mockResolvedValueOnce(undefined);
    await service.clearRewritten(() => true);
    expect(state.writes).toEqual([]);
    let selected = true;
    warning.mockImplementationOnce(() => {
      selected = false;
      return Promise.resolve('削除');
    });
    await service.clearRewritten(() => selected);
    expect(service.all).toEqual([]);
    expect(state.writes).toHaveLength(1);
  });
  it('入力待ちの内容変更と異なるコミットのファイルコメントを拒否する', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const uris = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const doc = await workspace.openTextDocument(uris.right);
    await expect(
      service.addFileComment({ ...target, commit: { ...target.commit, hash: target.parent } }, doc),
    ).rejects.toThrow('レビュー対象が変わりました。差分を開き直してください');
    input.mockImplementationOnce(() => {
      vi.spyOn(doc, 'getText').mockReturnValue('edited during prompt');
      return Promise.resolve('comment');
    });
    await expect(service.addFileComment(target, doc)).rejects.toThrow(WORKING_TREE_MISMATCH);
    expect(state.writes).toEqual([]);
  });
  it('patch取得中に対象が変わったら行コメントを保存しない', async () => {
    await commitAll(target.repo, 'switched', { amend: true });
    const commit = (await new GitClient(target.repo).log(0, 1))[0]!;
    const next = { ...target, commit };
    class SwitchingGit extends GitClient {
      override async patch(...args: Parameters<GitClient['patch']>) {
        const patch = await super.patch(...args);
        activateTab(
          new TabInputTextDiff(revisionUri(next, 'old'), Uri.file(join(target.repo, target.file.path)) as vscode.Uri),
        );
        return patch;
      }
    }
    const access = await accessFor(target.repo, (repo) => new SwitchingGit(repo));
    const documents = reviewDocuments(access);
    const uris = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const doc = await workspace.openTextDocument(uris.right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await expect(service.addRangeComment(reply(doc, 'changed'))).rejects.toThrow(
      'レビュー対象が変わりました。差分を開き直してください',
    );
    expect(state.writes).toEqual([]);
  });
  it('通常タブの併存でも編集中の本文を保持し、明示削除では破棄する', async () => {
    state.value = undefined;
    const uris = await documents.diffUris(target);
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    const doc = await workspace.openTextDocument(uris.right);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await service.addRangeComment(reply(doc, 'saved'));
    const thread = threads.find((item) => item.comments.length)!;
    await service.edit(thread);
    thread.comments[0]!.body = 'draft';
    activateTab(new TabInputText(uris.right));
    await service.refresh();
    expect(disposedThreads.has(thread)).toBe(false);
    expect(thread.comments[0]?.body).toBe('draft');
    await service.save(thread.comments[0]);
    expect(service.all[0]?.body).toBe('draft');
    expect(disposedThreads.has(thread)).toBe(true);
    activateTab(new TabInputTextDiff(uris.left, uris.right));
    await service.refresh();
    expect(thread.comments[0]?.body).toBe('draft');
    const restored = threads.at(-1)!;
    expect(restored.comments[0]?.body).toBe('draft');
    expect(restored.comments[0]?.mode).toBe(CommentMode.Preview);
    await service.delete(restored);
    expect(disposedThreads.has(restored)).toBe(true);
  });
  it('保存失敗では入力スレッドを残し、コメントノードから解決と削除を行う', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('new');
    const inputReply = reply(doc, 'retry');
    state.fail = true;
    await expect(service.addRangeComment(inputReply)).rejects.toThrow('disk full');
    expect(disposedThreads.has(inputReply.thread)).toBe(false);
    const node = { kind: 'comment', comment: saved };
    await service.toggle(node);
    expect(service.all[0]?.resolved).toBe(true);
    await service.delete(node);
    expect(service.all).toEqual([]);
  });
  it('コミットだけの共有実ファイルには保存済み比較のスレッドを表示する', async () => {
    saved = { ...saved, side: 'new' };
    state.value = serialize([saved]);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const { left, right } = await documents.diffUris(target);
    const other = { ...target, commit: { ...target.commit, hash: 'f'.repeat(40) } };
    activateTab(new TabInputTextDiff(revisionUri(other, 'old'), right));
    window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: new TabInputTextDiff(left, right) }] });
    const doc = await workspace.openTextDocument(right);
    await service.refresh();
    expect(
      threads.some(
        (thread) =>
          thread.uri.toString() === doc.uri.toString() &&
          thread.comments.some((comment) => comment.body === saved.body),
      ),
    ).toBe(true);
  });
  it('文書を閉じても保存済みの編集中スレッドを保持し、再表示で入力を戻す', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const doc = await open('old');
    const thread = threads[0]!;
    await service.edit(thread);
    thread.comments[0]!.body = 'draft after close';
    await documentClosed.fireAsync(doc);
    expect(disposedThreads.has(thread)).toBe(false);
    await documentOpened.fireAsync(doc);
    expect(thread.comments[0]?.body).toBe('draft after close');
    expect(thread.label).toContain(shortHash(target.commit.hash));
    await documentClosed.fireAsync(doc);
    docs.splice(docs.indexOf(doc), 1);
    await service.delete(thread);
    expect(disposedThreads.has(thread)).toBe(true);
  });

  it('管理外リポジトリへのファイルコメントは入力前に拒否する', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    await expect(service.addFileComment({ ...target, repo: '/outside' })).rejects.toThrow(
      'ワークスペース外のリポジトリは参照できません',
    );
    expect(input).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });
  it.each(['commit', 'mergeBase', 'number'] as const)(
    '行コメントの patch 取得中に比較の %s が変われば保存しない',
    async (change) => {
      const comparison = { ...pullRequestReview, headRefOid: target.commit.hash, mergeBase: target.parent };
      const initial = { ...target, pullRequest: comparison };
      const next: FileTarget =
        change === 'commit'
          ? target
          : {
              ...initial,
              parent: change === 'mergeBase' ? target.commit.hash : target.parent,
              pullRequest: {
                ...comparison,
                mergeBase: change === 'mergeBase' ? target.commit.hash : target.parent,
                number: change === 'number' ? 13 : comparison.number,
              },
            };
      class SwitchingGit extends GitClient {
        override async patch(...args: Parameters<GitClient['patch']>) {
          const patch = await super.patch(...args);
          activateTab(
            new TabInputTextDiff(revisionUri(next, 'old'), Uri.file(join(target.repo, target.file.path)) as vscode.Uri),
          );
          return patch;
        }
      }
      const selected = await accessFor(target.repo, (repo) => new SwitchingGit(repo));
      const documents = reviewDocuments(selected);
      const uris = await documents.diffUris(initial);
      activateTab(new TabInputTextDiff(uris.left, uris.right));
      const doc = await workspace.openTextDocument(uris.right);
      const service = new ReviewComments(state, vi.fn(), documents, selected, { review: () => comparison });
      await service.refresh();
      disposeAfter(service);
      await expect(service.addRangeComment(reply(doc, 'changed'))).rejects.toThrow('レビュー対象が変わりました');
      expect(state.writes).toEqual([]);
    },
  );
  it('同じ head の PR コメントとコミットコメントを各差分のスレッドへ分離する', async () => {
    const prTarget = {
      ...target,
      pullRequest: { ...pullRequestReview, headRefOid: target.commit.hash, mergeBase: target.parent },
    };
    const prComment = { ...saved, id: 'pr', pullRequest: prTarget.pullRequest, body: 'PR only' };
    state.value = serialize([saved, prComment]);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const commitDoc = await open('old');
    const uri = revisionUri(prTarget, 'old');
    const prDoc = textDocument(uri, await new RevisionProvider(access).provideTextDocumentContent(uri));
    docs.push(prDoc);
    await documentOpened.fireAsync(prDoc);
    expect(
      threads
        .filter((thread) => thread.uri.toString() === commitDoc.uri.toString())
        .flatMap((thread) => thread.comments.map((comment) => comment.body)),
    ).toEqual([saved.body]);
    expect(
      threads
        .filter((thread) => thread.uri.toString() === prDoc.uri.toString())
        .flatMap((thread) => thread.comments.map((comment) => comment.body)),
    ).toEqual(['PR only']);
  });
  it('共有する実ファイルにはアクティブな比較だけを表示し、フォーカスが離れても保持する', async () => {
    const comparison = { ...pullRequestReview, headRefOid: target.commit.hash, mergeBase: target.parent };
    const prTarget = { ...target, pullRequest: comparison };
    saved = { ...saved, side: 'new' };
    const prComment = { ...saved, id: 'pr', pullRequest: comparison, body: 'PR only' };
    state.value = serialize([saved, prComment]);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const right = Uri.file(join(target.repo, target.file.path)) as vscode.Uri;
    const group = window.tabGroups.activeTabGroup;
    const commitTab = { input: new TabInputTextDiff(revisionUri(target, 'old'), right) };
    const prTab = { input: new TabInputTextDiff(revisionUri(prTarget, 'old'), right) };
    const unrelated = { input: new TabInputText(Uri.file('/other') as vscode.Uri) };
    group.tabs = [commitTab, prTab, unrelated];
    group.activeTab = prTab;
    await workspace.openTextDocument(right);
    const visible = () =>
      threads
        .filter((thread) => !disposedThreads.has(thread) && thread.uri.toString() === right.toString())
        .flatMap((thread) => thread.comments.map((comment) => comment.body));
    await service.refresh();
    expect(visible()).toEqual(['PR only']);
    documents.recordActiveDiff(await documents.openDiffs());
    group.activeTab = unrelated;
    await service.refresh();
    expect(visible()).toEqual(['PR only']);
    group.activeTab = commitTab;
    await service.refresh();
    expect(visible()).toEqual([saved.body]);
  });
  it.each(['file', 'new'] as const)('PR の %s コメントに比較と表示情報を保存する', async (side) => {
    const comparison = {
      ...pullRequestReview,
      title: 'PR title',
      author: { login: 'PR author' },
      updatedAt: '2026-11-09T12:00:00Z',
      headRefOid: target.commit.hash,
      mergeBase: target.parent,
    };
    const prTarget = { ...target, pullRequest: comparison };
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => comparison });
    await service.refresh();
    disposeAfter(service);
    if (side === 'file') {
      input.mockResolvedValueOnce('saved PR comment');
      await service.addFileComment(prTarget);
    } else {
      const uri = revisionUri(prTarget, 'new');
      const doc = textDocument(uri, await new RevisionProvider(access).provideTextDocumentContent(uri));
      docs.push(doc);
      await service.addRangeComment(reply(doc, 'saved PR comment'));
    }
    const comment = deserialize(state.value).find((value) => value.body === 'saved PR comment')!;
    expect({
      pullRequest: comment.pullRequest,
      subject: comment.subject,
      author: comment.author,
      date: comment.date,
      side: comment.side,
    }).toEqual({
      pullRequest: comparison,
      subject: comparison.title,
      author: comparison.author.login,
      date: comparison.updatedAt,
      side,
    });
  });
  it('PR 情報が取得できなければコメントを保存しない', async () => {
    const prTarget = {
      ...target,
      pullRequest: { ...pullRequestReview, headRefOid: target.commit.hash, mergeBase: target.parent },
    };
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    input.mockResolvedValueOnce('question');
    await expect(service.addFileComment(prTarget)).rejects.toThrow('PR の情報を取得できません');
    expect(state.writes).toEqual([]);
  });
  it('範囲削除の件数には保存待ちの削除を反映する', async () => {
    state.value = serialize([saved, { ...saved, id: 'second' }]);
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = state.update.bind(state);
    vi.spyOn(state, 'update').mockImplementationOnce(async (key, value) => {
      await gate;
      await update(key, value);
    });
    const deleting = service.delete(saved);
    warning.mockResolvedValueOnce('削除');
    const clearing = service.clearMatching(() => true, 'このコミットの');
    await Promise.resolve();
    expect(warning).not.toHaveBeenCalled();
    release();
    await Promise.all([deleting, clearing]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'VSReview: このコミットのコメント 1 件を削除しますか？',
      { modal: true },
      '削除',
    );
    expect(service.all).toEqual([]);
  });

  it('保存待ちの削除で対象がなくなったら確認も追加保存もしない', async () => {
    const service = new ReviewComments(state, vi.fn(), documents, access, { review: () => undefined });
    await service.refresh();
    disposeAfter(service);
    const deleting = service.delete(saved);
    const clearing = service.clearMatching(() => true, 'このコミットの');
    await Promise.all([deleting, clearing]);
    expect(warning).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(1);
    expect(service.all).toEqual([]);
  });
});
