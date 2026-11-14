import {
  reviewDocuments,
  revisionArchives,
  pullRequestReview,
  repository,
  accessFor,
  reviewComment,
  gitProcesses,
  disposeAfter,
} from './fixtures';
import { deserialize, serialize } from '../src/core/model';
import { ChangedFiles } from '../src/ui/repositories';
import type * as vscode from 'vscode';
import { textDocument, window, activateTab, TabInputTextDiff, TabInputText, docs, Uri } from './vscodeMock';
import { CommitsTree } from '../src/ui/trees';
import { GitClient } from '../src/git/client';
import { describe, it, expect, vi } from 'vitest';
import { writeFile, unlink, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll } from './gitFixtures';
import { ReviewDocuments, AMBIGUOUS_REVIEW_TARGET, CONTENT_CACHE_LIMIT } from '../src/ui/documents';
import { revisionUri, documentRef, RevisionProvider } from '../src/ui/revisions';
import { targetFromComment, isFileTarget, revisionRef } from '../src/core/documents';
import { createUncommittedChanges } from '../src/git/uncommitted';

describe('documents', () => {
  it('未コミットURIはメタデータを検証し、保存後も同じ固定本文へ復元する', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'a.ts'), 'before\n');
    await commitAll(directory, 'base');
    await writeFile(join(directory, 'a.ts'), 'snapshot\n');
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
    const archives = revisionArchives(access);
    const expand = vi.spyOn(archives, 'uri').mockResolvedValue(Uri.file('/expanded') as vscode.Uri);
    const documents = new ReviewDocuments(access, archives);
    const pair = await documents.diffUris(target);
    expect([pair.left.scheme, pair.right.scheme]).toEqual(['vsreview', 'vsreview']);
    expect(expand).not.toHaveBeenCalled();
    await writeFile(join(directory, 'a.ts'), 'later\n');
    const provider = new RevisionProvider(access);
    expect(await provider.provideTextDocumentContent(pair.left)).toBe('before\n');
    expect(await provider.provideTextDocumentContent(pair.right)).toBe('snapshot\n');
    const ref = documentRef(pair.right)!;
    expect(ref.uncommitted).toEqual(target.uncommitted);
    expect(ref.commit).toMatchObject({
      subject: '未コミットの変更（未ステージ）',
      author: '',
      date: changes.createdAt,
    });
    for (const uncommitted of [
      null,
      {},
      { kind: 'bad', createdAt: 'now' },
      { kind: 'staged', head: 'bad', createdAt: 'now' },
      { kind: 'staged' },
    ]) {
      const uri = Uri.from({
        scheme: 'vsreview',
        path: pair.right.path,
        query: new URLSearchParams({ ref: JSON.stringify({ ...ref, uncommitted }) }).toString(),
      }) as vscode.Uri;
      expect(documentRef(uri)).toBeUndefined();
    }
    expect(isFileTarget({ ...target, pullRequest: pullRequestReview })).toBe(false);
    const saved = {
      ...reviewComment,
      repoRoot: directory,
      commit: ref.commit.hash,
      parent: ref.parent,
      path: ref.file.path,
      status: ref.file.status,
      uncommitted: target.uncommitted,
    };
    delete saved.oldPath;
    expect(revisionUri(targetFromComment(saved), 'new').toString()).toBe(pair.right.toString());
  });
  describe('コミットの文書', () => {
    async function fixture() {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'main.ts'), 'line\n');
      await commitAll(directory, 'initial');
      const old = (await git.log(0, 10))[0]!;
      await writeFile(join(directory, 'main.ts'), 'line\nnew\n');
      await commitAll(directory, 'head');
      const commit = (await git.log(0, 10))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'main.ts', status: 'M' as const },
      };
      const access = await accessFor(directory);
      return { directory, git, old, target, access, documents: reviewDocuments(access) };
    }
    it('一致する右側だけ実ファイルにし、左側と過去の異なる内容は仮想文書にする', async () => {
      const { target, documents, old, git, access } = await fixture();
      const current = await documents.diffUris(target);
      expect(current.left.scheme).toBe('vsreview');
      expect(current.right.fsPath).toBe(join(target.repo, 'main.ts'));
      const historical = await documents.diffUris({
        ...target,
        commit: old,
        parent: await git.parent(old),
        file: { path: 'main.ts', status: 'A' },
      });
      expect(historical.right.scheme).toBe('vsreview');
      const provider = new RevisionProvider(access);
      expect(await provider.provideTextDocumentContent(historical.left)).toBe('');
      expect(await provider.provideTextDocumentContent(historical.right)).toBe('line\n');
    });
    it('改行コード差・末尾改行差・未保存編集・ファイル削除は完全一致と見なさない', async () => {
      const { target, documents } = await fixture();
      for (const text of ['line\r\nnew\r\n', 'line\nnew']) {
        await writeFile(join(target.repo, 'main.ts'), text);
        expect((await documents.diffUris(target)).right.scheme).toBe('vsreview');
      }
      await writeFile(join(target.repo, 'main.ts'), 'line\nnew\n');
      docs.push(textDocument(Uri.file(join(target.repo, 'main.ts')) as vscode.Uri, 'unsaved', true));
      expect((await documents.diffUris(target)).right.scheme).toBe('vsreview');
      docs.length = 0;
      await unlink(join(target.repo, 'main.ts'));
      expect((await documents.diffUris(target)).right.scheme).toBe('vsreview');
    });
    it('管理外のリポジトリ・壊れた URI・不正引数・脱出パスを拒否する', async () => {
      const { target, documents, access } = await fixture();
      const foreign = { ...target, repo: '/outside' };
      const provider = new RevisionProvider(access);
      await expect(provider.provideTextDocumentContent(revisionUri(foreign, 'new'))).rejects.toThrow(
        'レビュー文書の URI またはリポジトリが不正です',
      );
      expect(await documents.targetFrom(foreign)).toBeUndefined();
      await expect(documents.diffUris(foreign)).rejects.toThrow('ワークスペース外のリポジトリは参照できません');
      expect(await documents.targetFrom({ repo: target.repo })).toBeUndefined();
      expect(await documents.resolve(revisionUri(foreign, 'new'))).toBeUndefined();
      expect(documentRef(Uri.from({ scheme: 'vsreview', query: 'ref=bad' }) as vscode.Uri)).toBeUndefined();
      const value = { ...target, file: { ...target.file, path: '../outside' } };
      expect(isFileTarget(value)).toBe(false);
    });
    it('通常タブや別の差分では実ファイルをレビュー文書として解決しない', async () => {
      const { target, documents } = await fixture();
      const { left, right } = await documents.diffUris(target);
      activateTab(new TabInputTextDiff(left, right));
      expect((await documents.resolve(right))?.side).toBe('new');
      activateTab(new TabInputText(right));
      expect(await documents.resolve(right)).toBeUndefined();
      activateTab(new TabInputTextDiff(Uri.file('/unrelated') as vscode.Uri, right));
      expect(await documents.resolve(right)).toBeUndefined();
    });
    it('保存コメントからの再表示でも同じ仮想URIを復元しバイナリを拒否する', async () => {
      const { target, access } = await fixture();
      const comment = {
        ...reviewComment,
        repoRoot: target.repo,
        commit: target.commit.hash,
        parent: target.parent,
        path: target.file.path,
        status: target.file.status,
        subject: target.commit.subject,
        author: target.commit.author,
        date: target.commit.date,
      };
      delete comment.oldPath;
      expect(isFileTarget(targetFromComment(comment))).toBe(true);
      expect(revisionUri(targetFromComment(comment), 'new').toString()).toBe(revisionUri(target, 'new').toString());
      await writeFile(join(target.repo, 'binary'), Buffer.from([0, 1]));
      await commitAll(target.repo, 'binary');
      const commit = (await access.client(target.repo).log(0, 10))[0]!;
      await expect(
        new RevisionProvider(access).provideTextDocumentContent(
          revisionUri({ ...target, commit, file: { path: 'binary', status: 'A' } }, 'new'),
        ),
      ).rejects.toThrow('バイナリファイルは表示できません');
    });
    it('外部へのシンボリックリンクは実ファイルとして開かない', async () => {
      const { target, documents } = await fixture();
      await unlink(join(target.repo, 'main.ts'));
      await symlink('/outside', join(target.repo, 'main.ts'));
      expect((await documents.diffUris(target)).right.scheme).toBe('vsreview');
    });

    it('rev・path・empty・side の改ざんを拒否し、引数なしとURI指定で同じ対象へ解決する', async () => {
      const { target, documents } = await fixture();
      const ref = revisionRef(target, 'old');
      for (const change of [{ rev: target.commit.hash }, { path: 'other' }, { empty: true }, { side: 'new' }]) {
        const uri = Uri.from({
          scheme: 'vsreview',
          path: '/main.ts',
          query: new URLSearchParams({ ref: JSON.stringify({ ...ref, ...change }) }).toString(),
        }) as vscode.Uri;
        expect(documentRef(uri)).toBeUndefined();
      }
      const uri = revisionUri(target, 'new');
      const doc = textDocument(uri, 'line\nnew\n');
      await window.showTextDocument(doc);
      expect(await documents.targetFrom()).toEqual(await documents.targetFrom(uri));
      expect(await documents.targetFrom(uri)).toMatchObject({
        repo: target.repo,
        commit: { hash: target.commit.hash },
        file: target.file,
      });
      window.activeTextEditor = undefined;
      expect(await documents.targetFrom()).toBeUndefined();
      expect(await documents.targetFrom(Uri.file('/outside'))).toBeUndefined();
    });

    it('打鍵時の一致判定は不変なコミット本文を再利用してGitを再実行しない', async () => {
      const { directory, target } = await fixture();
      const processes = gitProcesses();
      const access = await accessFor(directory);
      const documents = reviewDocuments(access);
      const uris = await documents.diffUris(target);
      activateTab(new TabInputTextDiff(uris.left, uris.right));
      const doc = textDocument(uris.right, 'line\nnew\n');
      expect(await documents.isCommentable(doc)).toBe(true);
      const startsBeforeTyping = processes.mock.calls.length;
      expect(startsBeforeTyping).toBeGreaterThan(0);
      for (let i = 0; i < 5; i++) {
        expect(await documents.isCommentable(textDocument(uris.right, `changed ${i}`, true))).toBe(false);
      }
      expect(processes.mock.calls).toHaveLength(startsBeforeTyping);
    });
    it('同じ実ファイルの複数差分はフォーカスを優先し、曖昧なら追加を拒否する', async () => {
      const { target, documents } = await fixture();
      const other = { ...target, commit: { ...target.commit, hash: 'f'.repeat(40) } };
      const { left, right } = await documents.diffUris(target);
      const otherLeft = revisionUri(other, 'old');
      expect(await documents.resolve(right)).toBeUndefined();
      activateTab(new TabInputTextDiff(left, right));
      expect((await documents.resolve(right))?.commit.hash).toBe(target.commit.hash);
      window.tabGroups.all.unshift({ activeTab: undefined, tabs: [{ input: new TabInputTextDiff(otherLeft, right) }] });
      expect((await documents.resolve(right))?.commit.hash).toBe(target.commit.hash);
      window.tabGroups.activeTabGroup.activeTab = undefined;
      expect(await documents.resolve(right)).toBeUndefined();
      await expect(documents.assertCommentable(textDocument(right, 'line\nnew\n'))).rejects.toThrow(
        AMBIGUOUS_REVIEW_TARGET,
      );
      expect((await documents.resolve(right, { commit: other.commit.hash }))?.commit.hash).toBe(other.commit.hash);
      expect(await documents.resolve(right, { commit: 'e'.repeat(40) })).toBeUndefined();
    });

    it('非アクティブなグループの差分から実ファイルを解決する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      const documents = reviewDocuments(await accessFor(directory));
      const { left, right } = await documents.diffUris(target);
      activateTab(undefined);
      for (let group = 0; group < 2; group++) {
        window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: new TabInputTextDiff(left, right) }] });
      }
      expect((await documents.resolve(right))?.commit.hash).toBe(commit.hash);
      expect((await documents.targetFrom(right))?.commit.hash).toBe(commit.hash);
    });

    it('表示パスと参照のパスが異なる仮想URIを拒否する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const uri = revisionUri(
        { repo: directory, commit, parent: await git.parent(commit), file: { path: 'file', status: 'A' } },
        'new',
      );
      expect(
        documentRef(Uri.from({ scheme: uri.scheme, path: '/fake', query: uri.query }) as vscode.Uri),
      ).toBeUndefined();
    });

    it('通常タブが別グループに共存すると実ファイルへのコメントを止める', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'one');
      await commitAll(directory, 'one');
      const commit = (await git.log(0, 1))[0]!;
      const target = {
        repo: directory,
        commit,
        parent: await git.parent(commit),
        file: { path: 'file', status: 'A' as const },
      };
      const documents = reviewDocuments(await accessFor(directory));
      const uris = await documents.diffUris(target);
      activateTab(new TabInputTextDiff(uris.left, uris.right));
      window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: new TabInputText(uris.right) }] });
      expect((await documents.resolve(uris.right))?.commit.hash).toBe(commit.hash);
      expect((await documents.targetFrom(uris.right))?.commit.hash).toBe(commit.hash);
      expect(await documents.fileCommentTargetFrom(uris.right)).toMatchObject({
        target: { repo: directory, commit: { hash: commit.hash }, file: target.file },
      });
      expect(await documents.isCommentable(textDocument(uris.right, 'one'))).toBe(false);
    });

    it('同じ内容のリポジトリ内リンクも実ファイル側へ使わない', async () => {
      const { target, documents } = await fixture();
      await writeFile(join(target.repo, 'same'), 'line\nnew\n');
      await unlink(join(target.repo, 'main.ts'));
      await symlink(join(target.repo, 'same'), join(target.repo, 'main.ts'));
      expect((await documents.diffUris(target)).right.scheme).toBe('vsreview');
    });
    it('本文キャッシュは上限で最古を追い出し、取得失敗後は再取得する', async () => {
      const { directory, git } = await repository();
      for (let index = 0; index <= CONTENT_CACHE_LIMIT; index++) {
        await writeFile(join(directory, `file${index}`), 'one');
      }
      await commitAll(directory, 'files');
      const commit = (await git.log(0, 1))[0]!;
      const parent = await git.parent(commit);
      const documents = reviewDocuments(await accessFor(directory));
      const check = async (index: number, resolver = documents) => {
        const target = { repo: directory, commit, parent, file: { path: `file${index}`, status: 'A' as const } };
        const right = Uri.file(join(directory, target.file.path)) as vscode.Uri;
        activateTab(new TabInputTextDiff(revisionUri(target, 'old'), right));
        return await resolver.isCommentable(textDocument(right, 'one'));
      };
      const processes = gitProcesses();
      expect(await check(0)).toBe(true);
      const initial = processes.mock.calls.length;
      expect(initial).toBeGreaterThan(0);
      expect(await check(0)).toBe(true);
      expect(processes.mock.calls).toHaveLength(initial);
      for (let index = 1; index <= CONTENT_CACHE_LIMIT; index++) {
        expect(await check(index)).toBe(true);
      }
      const full = processes.mock.calls.length;
      expect(await check(0)).toBe(true);
      expect(processes.mock.calls.length).toBeGreaterThan(full);
      class FailingOnceGit extends GitClient {
        private fail = true;
        override content(rev: string, path: string) {
          if (this.fail) {
            this.fail = false;
            return Promise.reject(new Error('temporary failure'));
          }
          return super.content(rev, path);
        }
      }
      const client = new FailingOnceGit(directory);
      const retry = reviewDocuments(await accessFor(directory, () => client));
      expect(await check(0, retry)).toBe(false);
      expect(await check(0, retry)).toBe(true);
    });
    it('リネームのツリーと保存コメントから左右の同じURIを復元する', async () => {
      const { target, git, access } = await fixture();
      await rename(join(target.repo, 'main.ts'), join(target.repo, 'renamed.ts'));
      await commitAll(target.repo, 'rename');
      const tree = new CommitsTree(() => [], access, new ChangedFiles(access));
      disposeAfter(tree);
      await tree.select(git);
      const root = (await tree.getChildren())[0]!;
      const node = (await tree.getChildren(root))[0]!;
      if (node.kind !== 'file') {
        throw new Error('missing file');
      }
      expect(node.file).toEqual({ status: 'R', oldPath: 'main.ts', path: 'renamed.ts' });
      const saved = {
        ...reviewComment,
        repoRoot: node.repo,
        commit: node.commit.hash,
        parent: node.parent,
        path: node.file.path,
        oldPath: node.file.oldPath!,
        status: node.file.status,
        subject: node.commit.subject,
        author: node.commit.author,
        date: node.commit.date,
      };
      for (const side of ['old', 'new'] as const) {
        const uri = revisionUri(node, side);
        expect(documentRef(uri)).toMatchObject({ path: side === 'old' ? 'main.ts' : 'renamed.ts' });
        expect(revisionUri(targetFromComment(saved), side).toString()).toBe(uri.toString());
      }
    });
    it('BOM付きの一致するファイルはBOMを除いたバッファで実ファイルを開く', async () => {
      const { target, git, documents } = await fixture();
      await writeFile(join(target.repo, 'main.ts'), '\uFEFFline\nnew\n');
      await commitAll(target.repo, 'BOM');
      const commit = (await git.log(0, 1))[0]!;
      const uri = Uri.file(join(target.repo, 'main.ts')) as vscode.Uri;
      docs.push(textDocument(uri, 'line\nnew\n'));
      expect((await documents.diffUris({ ...target, commit })).right.toString()).toBe(uri.toString());
      expect(await git.content(commit.hash, 'main.ts')).toEqual({ text: 'line\nnew\n', binary: false });
      await writeFile(uri.fsPath, 'line\nnew\n');
      expect((await documents.diffUris({ ...target, commit })).right.scheme).toBe('vsreview');
    });
  });

  describe('PR の比較 URI', () => {
    it('PR の表示情報が更新されても比較 URI は変わらない', () => {
      const original = { ...reviewComment, pullRequest: pullRequestReview };
      const updated = {
        ...original,
        subject: '新タイトル',
        author: '変更作者',
        date: '変更日時',
        pullRequest: { ...pullRequestReview, title: '新タイトル', updatedAt: '変更日時', headRefName: 'renamed' },
      };
      expect(revisionUri(targetFromComment(updated), 'new').toString()).toBe(
        revisionUri(targetFromComment(original), 'new').toString(),
      );
    });

    it.each(['headRefOid', 'mergeBase'] as const)(
      'PR の %s が比較と一致しない保存データと FileTarget を拒否する',
      (field) => {
        const comment = { ...reviewComment, pullRequest: { ...pullRequestReview, [field]: 'c'.repeat(40) } };
        expect(() => deserialize(serialize([comment]))).toThrow('保存されたレビューコメントの形式');
        expect(isFileTarget(targetFromComment(comment))).toBe(false);
      },
    );
  });

  it('通常コミットでもコメント入力中は直前にフォーカスした比較を使う', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'file'), 'same');
    await commitAll(directory, 'first');
    const first = (await git.log(0, 1))[0]!;
    await writeFile(join(directory, 'extra'), 'extra');
    await commitAll(directory, 'second');
    const second = (await git.log(0, 1))[0]!;
    const documents = reviewDocuments(await accessFor(directory));
    const right = Uri.file(join(directory, 'file')) as vscode.Uri;
    const tabs = await Promise.all(
      [first, second].map(async (commit) => ({
        input: new TabInputTextDiff(
          revisionUri(
            { repo: directory, commit, parent: await git.parent(commit), file: { path: 'file', status: 'M' } },
            'old',
          ),
          right,
        ),
      })),
    );
    const group = window.tabGroups.activeTabGroup;
    group.tabs = tabs;
    group.activeTab = tabs[1];
    documents.recordActiveDiff(await documents.openDiffs());
    group.activeTab = undefined;
    expect((await documents.assertCommentable(textDocument(right, 'same'))).commit.hash).toBe(second.hash);
    group.tabs = [tabs[0]!];
    documents.recordActiveDiff(await documents.openDiffs());
    expect((await documents.resolve(right))?.commit.hash).toBe(first.hash);
  });
  describe('PR の比較選択の寿命', () => {
    it('最後のアクティブ差分が閉じた後は残る二つの比較を曖昧として拒否する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'same');
      await commitAll(directory, 'root');
      const commit = (await git.log(0, 1))[0]!;
      const parent = await git.parent(commit);
      const target = { repo: directory, commit, parent, file: { path: 'file', status: 'A' as const } };
      const documents = reviewDocuments(await accessFor(directory));
      const right = Uri.file(join(directory, 'file')) as vscode.Uri;
      const tabs = [12, 13, 14].map((number) => ({
        input: new TabInputTextDiff(
          revisionUri({ ...target, pullRequest: { number, headRefOid: commit.hash, mergeBase: parent } }, 'old'),
          right,
        ),
      }));
      const group = window.tabGroups.activeTabGroup;
      group.tabs = tabs;
      group.activeTab = tabs[0];
      documents.recordActiveDiff(await documents.openDiffs());
      expect((await documents.resolve(right))?.pullRequest?.number).toBe(12);
      group.tabs = tabs.slice(1);
      group.activeTab = undefined;
      documents.recordActiveDiff(await documents.openDiffs());
      expect(await documents.resolve(right)).toBeUndefined();
      await expect(documents.assertCommentable(textDocument(right, 'same'))).rejects.toThrow(AMBIGUOUS_REVIEW_TARGET);
    });
    it('openDiffs の呼び出しだけでは直前のアクティブ比較を変えない', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'file'), 'same');
      await commitAll(directory, 'root');
      const commit = (await git.log(0, 1))[0]!;
      const parent = await git.parent(commit);
      const target = { repo: directory, commit, parent, file: { path: 'file', status: 'A' as const } };
      const documents = reviewDocuments(await accessFor(directory));
      const right = Uri.file(join(directory, 'file')) as vscode.Uri;
      const tabs = [12, 13].map((number) => ({
        input: new TabInputTextDiff(
          revisionUri({ ...target, pullRequest: { number, headRefOid: commit.hash, mergeBase: parent } }, 'old'),
          right,
        ),
      }));
      const group = window.tabGroups.activeTabGroup;
      group.tabs = tabs;
      group.activeTab = tabs[0];
      documents.recordActiveDiff(await documents.openDiffs());
      group.activeTab = tabs[1];
      await documents.openDiffs();
      group.activeTab = undefined;
      expect((await documents.resolve(right))?.pullRequest?.number).toBe(12);
    });
  });
});
