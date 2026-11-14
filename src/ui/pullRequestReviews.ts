import { forEachConcurrent } from '../core/collections';
import * as vscode from 'vscode';
import { comparisonKey } from '../core/comparisons';
import type { CommitTarget } from '../core/documents';
import type { ReviewComment } from '../core/model';
import type { PullRequest, PullRequestReview } from '../core/pullRequests';
import type { GitClient } from '../git/client';
import type { PullRequestSource } from '../git/gh';
import { ensurePullRequestHead } from '../git/pullRequests';

// 大量の保存 PR で接続を増やしすぎず、直列取得の待ちも減らすため4接続に制限する。
const HEAD_FETCH_CONCURRENCY = 4;
// 一覧の寿命と、開いている保存比較の寿命は異なるため、表示情報はツリーのノードから切り離す。
export class PullRequestReviews implements vscode.Disposable {
  private readonly reviews = new Map<string, PullRequestReview>();
  private readonly headsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeHeads = this.headsChanged.event;
  private heads = new Map<number, string>();
  private repo: string | undefined;
  private generation = 0;
  private readonly openedHeads = new Map<number, string>();
  constructor(
    private readonly comments: () => readonly ReviewComment[],
    private readonly openTargets: () => Promise<readonly CommitTarget[]>,
    private readonly source: PullRequestSource,
  ) {}
  latestHead = (repo: string, number: number): string | undefined =>
    repo === this.repo ? this.heads.get(number) : undefined;
  review = (target: CommitTarget): PullRequestReview | undefined => {
    const comparison = target.pullRequest;
    if (!comparison) {
      return undefined;
    }
    // 同じ head でも base が進むと別の比較になる。展開時点の情報を先に使う。
    return (
      this.reviews.get(comparisonKey(target)) ??
      this.comments().find((comment) => comparisonKey(comment) === comparisonKey(target))?.pullRequest
    );
  };
  rememberReview(target: CommitTarget, pullRequest: PullRequest): void {
    this.reviews.set(comparisonKey(target), { ...pullRequest, mergeBase: target.parent });
  }
  async reset(repo: string | undefined): Promise<void> {
    const generation = ++this.generation;
    this.repo = repo;
    this.heads.clear();
    this.openedHeads.clear();
    const retained = new Set((await this.openTargets()).map(comparisonKey));
    if (generation !== this.generation) {
      return;
    }
    for (const key of this.reviews.keys()) {
      if (!retained.has(key)) {
        this.reviews.delete(key);
      }
    }
  }
  async refreshHeads(git: GitClient, pullRequests: readonly PullRequest[]): Promise<void> {
    const generation = this.generation;
    const remote = this.source.remote();
    const heads = new Map(pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.headRefOid]));
    const saved = new Map<number, PullRequestReview>();
    for (const comment of this.comments()) {
      if (comment.repoRoot === git.root && comment.pullRequest) {
        saved.set(comment.pullRequest.number, comment.pullRequest);
      }
    }
    for (const target of await this.openTargets()) {
      const review = this.review(target);
      if (target.repo === git.root && review) {
        saved.set(review.number, review);
      }
    }
    await forEachConcurrent([...saved], HEAD_FETCH_CONCURRENCY, async ([number, comparison]) => {
      if (generation !== this.generation) {
        return;
      }
      try {
        const latest = heads.get(number) ?? (await this.source.gh(git.root).viewOpenHead(number));
        if (!latest) {
          return;
        }
        // 書き換え判定は head だけで足りる。base の消失で head の収集を止めない。
        await ensurePullRequestHead(git, { number, url: comparison.url, headRefOid: latest }, remote);
        heads.set(number, latest);
      } catch {
        heads.delete(number); // 取得失敗時は直前の判定を保つ。
      }
    });
    if (generation === this.generation) {
      // 番号指定後に完了した古い一覧応答で、開き直した head を巻き戻さない。
      for (const [number, head] of this.openedHeads) {
        heads.set(number, head);
      }
      this.heads = heads;
      this.headsChanged.fire();
    }
  }
  rememberHead(repo: string, pullRequest: PullRequest): void {
    if (repo !== this.repo || pullRequest.state !== 'OPEN') {
      return;
    }
    this.heads.set(pullRequest.number, pullRequest.headRefOid);
    this.openedHeads.set(pullRequest.number, pullRequest.headRefOid);
    this.headsChanged.fire();
  }
  dispose(): void {
    this.generation++;
    this.headsChanged.dispose();
  }
}
