import { normalTabUris } from './tabs';
import { selectReviewTarget, isWorkingTreeUri, type ResolveOptions, type OpenDiff } from './reviewTargets';
import type { RevisionArchives } from './revisionArchives';
import * as vscode from 'vscode';
import { groupBy, PromiseCache } from '../core/collections';
import { isRealFileWithin } from '../git/paths';
import { comparisonKey } from '../core/comparisons';
import { isFileTarget, revisionRef, type DocumentRef, type FileTarget } from '../core/documents';
import { repoFile } from '../core/paths';
import { resolveDocumentRef, revisionUri } from './revisions';
import type { RepositoryAccess } from './repositories';
export const NOT_COMMENTABLE = 'この文書にはコメントを追加できません';
export const AMBIGUOUS_REVIEW_TARGET =
  '同じファイルの差分が複数あります。コメントを追加する差分にフォーカスしてください';
export const WORKING_TREE_MISMATCH = '作業ツリーの内容がコミットと一致しません。差分を開き直してください';
export const REVIEW_TARGET_CHANGED = 'レビュー対象が変わりました。差分を開き直してください';

export const CONTENT_CACHE_LIMIT = 32;
export class ReviewDocuments {
  private readonly fileDiffGroups = new WeakMap<readonly OpenDiff[], Map<string, OpenDiff[]>>();
  // コメント入力へフォーカスが移っても、直前の比較を保持する。
  private lastActiveDiff: string | undefined;
  private readonly contents = new PromiseCache<string>(CONTENT_CACHE_LIMIT);
  constructor(
    private readonly access: RepositoryAccess,
    private readonly archives: Pick<
      RevisionArchives,
      | 'uri'
      | 'owns'
      | 'refs'
      | 'isSource'
      | 'pairRef'
      | 'rememberPair'
      | 'resolve'
      | 'matchesContent'
      | 'assertCommentable'
    >,
  ) {}
  private uriFrom(argument: unknown): vscode.Uri | undefined {
    return argument instanceof vscode.Uri
      ? argument
      : argument === undefined
        ? vscode.window.activeTextEditor?.document.uri
        : undefined;
  }
  async targetFrom(argument?: unknown): Promise<FileTarget | undefined> {
    const uri = this.uriFrom(argument);
    return uri
      ? await this.assertUnambiguous(uri)
      : isFileTarget(argument) && this.access.isKnown(argument.repo)
        ? argument
        : undefined;
  }
  private async fileDiffs(uri: vscode.Uri, options: { diffs?: readonly OpenDiff[] } = {}) {
    const diffs = options.diffs ?? (await this.openDiffs());
    let groups = this.fileDiffGroups.get(diffs);
    if (!groups) {
      groups = groupBy(
        diffs.filter(
          ({ ref, right }) =>
            ref.side === 'old' && ref.file.status !== 'D' && isWorkingTreeUri(ref.repo, ref.file.path, right),
        ),
        ({ right }) => right.toString(),
      );
      this.fileDiffGroups.set(diffs, groups);
    }
    return groups.get(uri.toString()) ?? [];
  }

  async resolve(uri: vscode.Uri, options: ResolveOptions = {}): Promise<DocumentRef | undefined> {
    const { commit, comparison } = options;
    const matchesComparison = (ref: DocumentRef): boolean =>
      !comparison || comparisonKey(ref) === comparisonKey(comparison);
    if (uri.scheme === 'vsreview') {
      const ref = resolveDocumentRef(uri, this.access);
      return ref && matchesComparison(ref) && (commit === undefined || ref.commit.hash === commit) ? ref : undefined;
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    if (await this.archives.owns(uri)) {
      return await this.archives.resolve(uri, {
        ...options,
        diffs: options.diffs ?? (await this.openDiffs()),
        lastActiveDiff: this.lastActiveDiff,
      });
    }
    const targets = await this.fileDiffs(uri, options);
    const target = selectReviewTarget(targets, { ...options, lastActiveDiff: this.lastActiveDiff });

    return target && matchesComparison(target.ref) ? revisionRef(target.ref, 'new') : undefined;
  }
  normalTabUris(): ReadonlySet<string> {
    return new Set(normalTabUris().map((uri) => uri.toString()));
  }
  async canShowComments(uri: vscode.Uri, normalTabUris = this.normalTabUris()): Promise<boolean> {
    // 作業ツリーの URI は編集用タブと共有される。展開先はリビジョン固有なので併存を許す。
    return (await this.archives.owns(uri)) || uri.scheme !== 'file' || !normalTabUris.has(uri.toString());
  }
  private async assertUnambiguous(uri: vscode.Uri): Promise<DocumentRef | undefined> {
    const diffs = await this.openDiffs();
    const ref = await this.resolve(uri, { diffs });
    if (
      !ref &&
      uri.scheme === 'file' &&
      (new Set((await this.fileDiffs(uri, { diffs })).map(({ ref }) => revisionUri(ref, 'old').toString())).size > 1 ||
        (await this.archives.refs(uri)).length > 1)
    ) {
      throw new Error(AMBIGUOUS_REVIEW_TARGET);
    }
    return ref;
  }
  async openDiffs(): Promise<OpenDiff[]> {
    const diffs: OpenDiff[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputTextDiff)) {
          continue;
        }
        const ref =
          resolveDocumentRef(input.original, this.access) ??
          (await this.archives.pairRef(input.original, input.modified));
        if (ref) {
          diffs.push({ ref, right: input.modified, active: tab === vscode.window.tabGroups.activeTabGroup.activeTab });
        }
      }
    }
    return diffs;
  }
  recordActiveDiff(diffs: readonly OpenDiff[]): void {
    const active = diffs.find(({ active }) => active);
    if (active) {
      this.lastActiveDiff = revisionUri(active.ref, 'old').toString();
    } else if (!diffs.some(({ ref }) => revisionUri(ref, 'old').toString() === this.lastActiveDiff)) {
      this.lastActiveDiff = undefined;
    }
  }
  async openDiffRefs() {
    return (await this.openDiffs()).map(({ ref }) => ref);
  }
  async openDiffTargets() {
    return (await this.openDiffRefs()).map((ref) => ({
      repoRoot: ref.repo,
      commit: ref.commit.hash,
      parent: ref.parent,
      ...(ref.pullRequest ? { pullRequest: ref.pullRequest } : {}),
      ...(ref.uncommitted ? { uncommitted: ref.uncommitted } : {}),
    }));
  }
  async fileCommentTargetFrom(
    argument?: unknown,
  ): Promise<{ target: FileTarget; document: vscode.TextDocument | undefined } | undefined> {
    const uri = this.uriFrom(argument);
    const target = await this.targetFrom(argument);
    return target
      ? { target, document: uri?.scheme === 'file' ? await vscode.workspace.openTextDocument(uri) : undefined }
      : undefined;
  }
  private async matchesRevision(ref: DocumentRef, document?: vscode.TextDocument): Promise<boolean> {
    let doc = document;
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(repoFile(ref.repo, ref.path)));
      } catch {
        return false;
      }
    }
    return doc.getText() === (await this.text(ref));
  }
  private async matchesWorkingTree(ref: DocumentRef, document?: vscode.TextDocument): Promise<boolean> {
    if (!(await this.access.client(ref.repo).matchesWorking(ref.rev, ref.path))) {
      return false;
    }
    // Git の検査後にリンク先が差し替わる窓を狭め、開いたバッファも許可ルート内か確認する。
    const uri = document?.uri ?? vscode.Uri.file(repoFile(ref.repo, ref.path));
    return (await isRealFileWithin(ref.repo, uri.fsPath)) && this.matchesRevision(ref, document);
  }
  private text(ref: DocumentRef): Promise<string> {
    const key = JSON.stringify([ref.repo, ref.rev, ref.path]);
    return this.contents.get(key, () =>
      this.access
        .client(ref.repo)
        .content(ref.rev, ref.path)
        .then((value) => value.text),
    );
  }

  async diffUris(target: FileTarget): Promise<{ left: vscode.Uri; right: vscode.Uri }> {
    this.access.assertKnown(target.repo);
    const [left, right] = await Promise.all([
      this.sideUri(revisionRef(target, 'old')),
      this.sideUri(revisionRef(target, 'new')),
    ]);
    const pair = { left, right };
    await this.archives.rememberPair(pair.left, pair.right, revisionRef(target, 'old'));
    return pair;
  }

  private async sideUri(ref: DocumentRef): Promise<vscode.Uri> {
    // 作業ツリーの編集や展開設定にかかわらず、選択時のスナップショットを固定表示する。
    if (ref.uncommitted) {
      return revisionUri(ref, ref.side);
    }
    if (!ref.empty) {
      // 旧側は作業ツリーの編集から隔離し、履歴の表示内容を固定する。
      if (ref.side === 'new' && (await this.matchesWorkingTree(ref))) {
        return vscode.Uri.file(repoFile(ref.repo, ref.path));
      }
      const expanded = await this.archives.uri(ref);
      if (expanded) {
        return expanded;
      }
    }
    return revisionUri(ref, ref.side);
  }
  async revisionFileUri(ref: DocumentRef): Promise<vscode.Uri> {
    return (await this.archives.uri(ref)) ?? revisionUri(ref, ref.side);
  }
  async isExpanded(uri: vscode.Uri): Promise<boolean> {
    return this.archives.owns(uri);
  }
  async matchesExpanded(ref: DocumentRef, document: vscode.TextDocument): Promise<boolean> {
    return this.archives.matchesContent(document, await this.text(ref));
  }
  async assertCommentable(document: vscode.TextDocument): Promise<DocumentRef> {
    const ref = await this.assertUnambiguous(document.uri);
    if (!ref || ref.empty) {
      throw new Error(NOT_COMMENTABLE);
    }
    if (document.uri.scheme === 'file') {
      if (await this.archives.owns(document.uri)) {
        await this.archives.assertCommentable(document, await this.text(ref));
      } else if (!(await this.matchesWorkingTree(ref, document))) {
        throw new Error(WORKING_TREE_MISMATCH);
      }
    }
    return ref;
  }
  async isCommentable(document: vscode.TextDocument): Promise<boolean> {
    try {
      const ref = await this.resolve(document.uri);
      // コミットの内容は不変なので、打鍵時の範囲再問い合わせでは Git を再実行しない。
      return Boolean(
        (await this.canShowComments(document.uri)) &&
        ref &&
        !ref.empty &&
        (document.uri.scheme !== 'file' ||
          ((await this.archives.owns(document.uri))
            ? await this.matchesExpanded(ref, document)
            : await this.matchesRevision(ref, document))),
      );
    } catch {
      return false;
    }
  }
}
