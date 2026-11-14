import type { OpenDiff } from './reviewTargets';
import { SerialQueue } from '../core/collections';
import { PULL_REQUEST_REOPEN } from '../core/pullRequests';
import type { PullRequestReviews } from './pullRequestReviews';
import { comparisonKey } from '../core/comparisons';
import type { FileTarget } from '../core/documents';
import { selectComments, deserialize, serialize, type ReviewComment } from '../core/model';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { groupBy } from '../core/collections';
import { anchorContext } from '../core/anchor';
import { isRecord } from '../core/validation';
import { shortHash, locationLabel, resolvedLabel } from '../core/presentation';
import { commentRange } from './ranges';
import { commentLines } from '../core/ranges';
import { NOT_COMMENTABLE, REVIEW_TARGET_CHANGED, type ReviewDocuments } from './documents';
import type { RepositoryAccess } from './repositories';
import { confirmClear, showError } from './common';

interface UiComment extends vscode.Comment {
  id: string;
  body: string;
}
type CommentabilityObservation = {
  returned?: boolean;
  desired?: boolean;
  querying: boolean;
  requested?: boolean;
};
function isEditing(thread: vscode.CommentThread): boolean {
  return thread.comments.some((c) => c.mode === vscode.CommentMode.Editing);
}
const STORAGE_KEY = 'vsreview.comments';
export class ReviewComments implements vscode.Disposable {
  private values: ReviewComment[];
  private readonly queue = new SerialQueue();
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<vscode.CommentThread, string>();
  // 最後に返した範囲と refresh の判定を比較する。
  // rangeUris は打鍵時に使い、まだ範囲を問い合わせられていない差分の右文書も対象にする。
  private readonly commentability = new Map<string, CommentabilityObservation>();
  private rangeUris = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  constructor(
    private readonly state: vscode.Memento,
    private readonly changed: () => void,
    private readonly documents: ReviewDocuments,
    private readonly access: RepositoryAccess,
    private readonly pullRequestReviews: Pick<PullRequestReviews, 'review'>,
  ) {
    this.values = deserialize(state.get<unknown>(STORAGE_KEY));
    this.controller = vscode.comments.createCommentController('vsreview', 'VSReview');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (document, token) => {
        const uri = document.uri.toString();
        // 問い合わせごとのオブジェクトで識別し、遅い旧応答で最新の問い合わせの記録を戻さない。
        const observation = {
          returned: this.commentability.get(uri)?.returned,
          querying: true,
        } as CommentabilityObservation;
        if (!document.isClosed) {
          this.commentability.set(uri, observation);
        }
        let commentable: boolean;
        try {
          commentable = await this.documents.isCommentable(document);
        } catch (error) {
          if (this.commentability.get(uri) === observation) {
            observation.querying = false;
          }
          throw error;
        }
        if (!document.isClosed && !token.isCancellationRequested && this.commentability.get(uri) === observation) {
          observation.returned = commentable;
          observation.querying = false;
          if (this.needsRangeQuery(observation)) {
            this.requeryRanges();
          }
        } else if (this.commentability.get(uri) === observation) {
          observation.querying = false;
        }
        return commentable
          ? [new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)]
          : [];
      },
    };
    this.controller.options = { prompt: 'レビューコメントを入力', placeHolder: '修正してほしい点や質問' };
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.queue.run(() => this.restoreThreads(doc)).catch(showError)),
      vscode.workspace.onDidCloseTextDocument((doc) =>
        this.queue
          .run(() => {
            this.removeThreads(doc.uri);
            this.commentability.delete(doc.uri.toString());
            return Promise.resolve();
          })
          .catch(showError),
      ),
    );
    void this.refresh().catch(showError);
  }
  get all(): readonly ReviewComment[] {
    return this.values;
  }
  private mutate(change: (values: readonly ReviewComment[]) => ReviewComment[], previewId?: string): Promise<void> {
    return this.queue.run(async () => {
      const updated = change(this.values);
      await this.state.update(STORAGE_KEY, serialize(updated));
      this.values = updated;
      await this.render({ previewId });
      this.changed();
    });
  }
  private removeThreads(uri: vscode.Uri): void {
    for (const [thread, id] of this.threads) {
      if (thread.uri.toString() === uri.toString() && !(isEditing(thread) && this.values.some((c) => c.id === id))) {
        thread.dispose();
        this.threads.delete(thread);
      }
    }
  }
  private ui(comment: ReviewComment): UiComment {
    return {
      id: comment.id,
      body: comment.body,
      mode: vscode.CommentMode.Preview,
      author: { name: 'レビュー' },
      contextValue: 'vsreview.comment',
      timestamp: new Date(comment.updatedAt),
    };
  }
  private async restoreThreads(
    doc: vscode.TextDocument,
    options: { previewId?: string | undefined; diffs?: readonly OpenDiff[]; normalTabUris?: ReadonlySet<string> } = {},
  ): Promise<void> {
    const { previewId } = options;
    const diffs = options.diffs ?? (await this.documents.openDiffs());
    const canShowComments = await this.documents.canShowComments(doc.uri, options.normalTabUris);
    const refs = await Promise.all(
      [...groupBy(this.values, comparisonKey)].map(async ([, values]) => {
        const comparison = values[0];
        if (!comparison) {
          return undefined;
        }
        const ref = canShowComments
          ? await this.documents.resolve(doc.uri, { commit: comparison.commit, comparison, diffs })
          : undefined;
        return ref && !ref.empty ? ref : undefined;
      }),
    );
    const comments = refs.flatMap((ref) =>
      ref
        ? selectComments(
            this.values.filter((value) => comparisonKey(value) === comparisonKey(ref)),
            { repoRoot: ref.repo, path: ref.file.path, side: ref.side },
          )
        : [],
    );
    // フォーカスやタブが変わっても、保存済みの編集中スレッドは入力を失わないよう残す。
    for (const [thread, id] of this.threads) {
      if (
        thread.uri.toString() === doc.uri.toString() &&
        !comments.some((c) => c.id === id) &&
        !(previewId !== id && this.values.some((c) => c.id === id) && isEditing(thread))
      ) {
        thread.dispose();
        this.threads.delete(thread);
      }
    }
    for (const comment of comments) {
      const range = commentRange(comment, doc);
      let thread = [...this.threads].find(
        ([thread, id]) => id === comment.id && thread.uri.toString() === doc.uri.toString(),
      )?.[0];
      if (!thread) {
        thread = this.controller.createCommentThread(doc.uri, range, [this.ui(comment)]);
        thread.canReply = false;
        thread.contextValue = 'vsreview.savedThread';
        this.threads.set(thread, comment.id);
      } else if (previewId === comment.id || !isEditing(thread)) {
        const body = thread.comments[0]?.body;
        if (previewId === comment.id || body !== comment.body) {
          thread.comments = [this.ui(comment)];
        }
      }
      // 同じ値の再代入でも VS Code が入力欄を作り直し、フォーカスが失われるため変更時だけ更新する。
      const label = `${shortHash(comment.commit)} · ${locationLabel(comment)} · ${resolvedLabel(comment.resolved)}`;
      const state = comment.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      if (thread.label !== label) {
        thread.label = label;
      }
      if (thread.state !== state) {
        thread.state = state;
      }
    }
  }
  refresh(options: { diffs?: readonly OpenDiff[] } = {}): Promise<void> {
    return this.queue.run(() => this.refreshThreads(options));
  }
  private async refreshThreads(options: { diffs?: readonly OpenDiff[] }): Promise<void> {
    const diffs = options.diffs ?? (await this.documents.openDiffs());
    const normalTabUris = this.documents.normalTabUris();
    await this.render({ diffs, normalTabUris });
    this.rangeUris = new Set(diffs.map(({ right }) => right.toString()));
    // タブ構成の変化だけで再登録すると、VS Code が未保存の入力欄を作り直す。
    // 先に範囲を問い合わせ済みなら、その結果から表示可否が変わった文書だけを通知する。
    const openDocuments = new Map(
      vscode.workspace.textDocuments.filter((doc) => !doc.isClosed).map((doc) => [doc.uri.toString(), doc]),
    );
    const changes = await Promise.all(
      [...this.commentability.keys()].map(async (uri) => {
        const document = openDocuments.get(uri);
        if (!document) {
          this.commentability.delete(uri);
          return false;
        }
        const observed = this.commentability.get(uri)!;
        const commentable = await this.documents.isCommentable(document);
        // 新しい問い合わせや close を優先し、進行中の問い合わせには完了後の比較を任せる。
        if (this.commentability.get(uri) !== observed || document.isClosed) {
          return false;
        }
        observed.desired = commentable;
        return this.needsRangeQuery(observed);
      }),
    );
    if (changes.some(Boolean)) {
      this.requeryRanges();
    }
  }

  private needsRangeQuery(observed: CommentabilityObservation): boolean {
    if (observed.returned === observed.desired) {
      delete observed.requested;
      return false;
    }
    if (
      observed.querying ||
      observed.returned === undefined ||
      observed.desired === undefined ||
      observed.requested === observed.desired
    ) {
      return false;
    }
    return true;
  }
  async refreshDocument(document: vscode.TextDocument): Promise<void> {
    if (
      !this.rangeUris.has(document.uri.toString()) &&
      !(
        (document.uri.scheme === 'vsreview' || (await this.documents.isExpanded(document.uri))) &&
        (await this.documents.resolve(document.uri))
      )
    ) {
      return;
    }
    // 打鍵時のスレッド復元は入力欄を作り直すため、範囲だけを更新する。
    this.requeryRanges();
  }
  private requeryRanges(): void {
    const provider = this.controller.commentingRangeProvider;
    if (provider) {
      // VS Code は非表示文書をすぐには問い合わせ直さない。同じ差を繰り返し通知すると表示中の入力欄を壊す。
      // 判定全体が成功して実際に通知するときだけ記録し、途中のエラーで更新を失わない。
      for (const observed of this.commentability.values()) {
        if (!observed.querying && observed.desired !== undefined && observed.returned !== observed.desired) {
          observed.requested = observed.desired;
        }
      }
      // 再代入で VS Code に範囲を問い合わせ直させ、未保存の変更を反映する。
      this.controller.commentingRangeProvider = provider;
    }
  }
  private async render(
    options: { previewId?: string | undefined; diffs?: readonly OpenDiff[]; normalTabUris?: ReadonlySet<string> } = {},
  ): Promise<void> {
    for (const [thread, id] of this.threads) {
      if (!this.values.some((comment) => comment.id === id)) {
        thread.dispose();
        this.threads.delete(thread);
      }
    }
    const diffs = options.diffs ?? (await this.documents.openDiffs());
    const normalTabUris = options.normalTabUris ?? this.documents.normalTabUris();
    await Promise.all(
      vscode.workspace.textDocuments.map((doc) => this.restoreThreads(doc, { ...options, diffs, normalTabUris })),
    );
  }
  private base(
    target: FileTarget,
    body: string,
  ): Omit<ReviewComment, 'side' | 'startLine' | 'endLine' | 'code' | 'hunkHeader' | 'excerpt'> {
    const now = new Date().toISOString();
    const pullRequest = this.pullRequestReviews.review(target);
    if (target.pullRequest && !pullRequest) {
      throw new Error(`PR の情報を取得できません。${PULL_REQUEST_REOPEN}`);
    }
    return {
      id: randomUUID(),
      repoRoot: target.repo,
      ...(pullRequest ? { pullRequest } : {}),
      commit: target.commit.hash,
      parent: target.parent,
      path: target.file.path,
      ...(target.file.oldPath === undefined ? {} : { oldPath: target.file.oldPath }),
      status: target.file.status,
      body,
      createdAt: now,
      updatedAt: now,
      resolved: false,
      subject: pullRequest?.title ?? target.commit.subject,
      author: pullRequest?.author.login ?? target.commit.author,
      date: pullRequest?.updatedAt ?? target.commit.date,
    };
  }
  async addRangeComment(argument: unknown): Promise<void> {
    if (
      !isRecord(argument) ||
      !isRecord(argument.thread) ||
      typeof argument.text !== 'string' ||
      !(argument.thread.uri instanceof vscode.Uri) ||
      !(argument.thread.range instanceof vscode.Range) ||
      typeof argument.thread.dispose !== 'function'
    ) {
      return;
    }
    const reply = argument as unknown as vscode.CommentReply;
    if (!reply.text.trim()) {
      return;
    }
    // 管理外 URI を openTextDocument に渡す前に拒否する。
    if (!(await this.documents.targetFrom(reply.thread.uri))) {
      throw new Error(NOT_COMMENTABLE);
    }
    const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
    const ref = await this.documents.assertCommentable(doc);
    const { startLine, endLine } = commentLines(reply.thread.range);
    // 変更 hunk の外の行にも前後3行の抜粋を付けるため、文書全体が入る context を要求する。
    const patch = await this.access.client(ref.repo).patch(ref.parent, ref.commit.hash, ref.file, doc.lineCount);
    const current = await this.documents.assertCommentable(doc);
    if (comparisonKey(current) !== comparisonKey(ref) || current.side !== ref.side) {
      throw new Error(REVIEW_TARGET_CHANGED);
    }
    const comment: ReviewComment = {
      ...this.base(ref, reply.text),
      side: ref.side,
      startLine,
      endLine,
      ...anchorContext(doc.getText(), patch, ref.side, startLine, endLine),
    };
    await this.mutate((values) => [...values, comment]);
    reply.thread.dispose();
  }
  async addFileComment(target: FileTarget, document?: vscode.TextDocument): Promise<void> {
    this.access.assertKnown(target.repo);
    const validate = async (): Promise<void> => {
      if (document?.uri.scheme === 'file') {
        const ref = await this.documents.assertCommentable(document);
        if (comparisonKey(ref) !== comparisonKey(target)) {
          throw new Error(REVIEW_TARGET_CHANGED);
        }
      }
    };
    await validate();
    const body = await vscode.window.showInputBox({
      title: 'ファイル全体へのレビューコメント',
      prompt: target.file.path,
      ignoreFocusOut: true,
    });
    if (!body?.trim()) {
      return;
    }
    await validate();
    const comment: ReviewComment = {
      ...this.base(target, body),
      side: 'file',
      startLine: 0,
      endLine: 0,
      code: '',
      hunkHeader: '',
      excerpt: '',
    };
    await this.mutate((values) => [...values, comment]);
  }
  id(argument: unknown): string | undefined {
    for (const [thread, id] of this.threads) {
      if (thread === argument) {
        return id;
      }
    }
    if (!isRecord(argument)) {
      return undefined;
    }
    if ('id' in argument && typeof argument.id === 'string') {
      return argument.id;
    }
    if ('comment' in argument) {
      return this.id(argument.comment);
    }
    return undefined;
  }
  async edit(argument: unknown): Promise<void> {
    const id = this.id(argument);
    if (!id) {
      return;
    }
    const saved = this.values.find((c) => c.id === id);
    // ツリーからの編集ではスレッドが開いていないことがあるため入力ボックスを使う。
    if (isRecord(argument) && 'kind' in argument && saved) {
      const body = await vscode.window.showInputBox({
        title: 'レビューコメントを編集',
        value: saved.body,
        ignoreFocusOut: true,
      });
      if (body?.trim()) {
        await this.mutate((values) =>
          values.map((c) => (c.id === id ? { ...c, body, updatedAt: new Date().toISOString() } : c)),
        );
      }
      return;
    }
    for (const [thread, commentId] of this.threads) {
      if (commentId === id) {
        if (saved) {
          thread.comments = [{ ...this.ui(saved), mode: vscode.CommentMode.Editing }];
        }
      }
    }
  }
  async save(argument: unknown): Promise<void> {
    const id = this.id(argument);
    if (!id || !this.values.some((c) => c.id === id)) {
      return;
    }
    if (!isRecord(argument) || typeof argument.body !== 'string') {
      return;
    }
    const body = argument.body;
    if (!body.trim()) {
      return;
    }
    await this.mutate(
      (values) => values.map((c) => (c.id === id ? { ...c, body, updatedAt: new Date().toISOString() } : c)),
      id,
    );
  }
  cancelEdit(argument: unknown): void {
    const id = this.id(argument);
    if (!id) {
      return;
    }
    for (const [thread, commentId] of this.threads) {
      if (id !== commentId) {
        continue;
      }
      const comment = this.values.find((c) => c.id === commentId);
      if (comment && isEditing(thread)) {
        thread.comments = [this.ui(comment)];
      }
    }
  }
  async delete(argument: unknown): Promise<void> {
    const id = this.id(argument);
    if (id && this.values.some((c) => c.id === id)) {
      await this.mutate((values) => values.filter((c) => c.id !== id));
    }
  }
  async toggle(argument: unknown): Promise<void> {
    const id = this.id(argument);
    if (id && this.values.some((c) => c.id === id)) {
      await this.mutate((values) =>
        values.map((c) => (c.id === id ? { ...c, resolved: !c.resolved, updatedAt: new Date().toISOString() } : c)),
      );
    }
  }
  async clear(): Promise<void> {
    if (await confirmClear('保存したレビューコメントをすべて削除しますか？')) {
      await this.mutate(() => []);
    }
  }
  async clearMatching(predicate: (comment: ReviewComment) => boolean, scope: string): Promise<void> {
    await this.queue.idle();
    // 確認中に追加されたコメントを削除しないよう、ダイアログを開く前に ID を確定する。
    const ids = new Set(this.values.filter(predicate).map((comment) => comment.id));
    if (ids.size && (await confirmClear(`${scope}コメント ${ids.size} 件を削除しますか？`, '削除'))) {
      await this.mutate((values) => values.filter((comment) => !ids.has(comment.id)));
    }
  }
  async clearRewritten(predicate: (comment: ReviewComment) => boolean): Promise<void> {
    const ids = new Set(this.values.filter(predicate).map((c) => c.id));
    if (ids.size && (await confirmClear('書き換え済みコミットのコメントを削除しますか？', '削除'))) {
      await this.mutate((values) => values.filter((c) => !ids.has(c.id)));
    }
  }
  dispose(): void {
    this.disposables.forEach((d) => {
      d.dispose();
    });
    this.controller.dispose();
  }
}
