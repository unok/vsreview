import * as vscode from 'vscode';
import { forEachConcurrent, PromiseCache, SerialQueue } from '../core/collections';
import { comparisonKey } from '../core/comparisons';
import type { CommitTarget } from '../core/documents';
import {
  explanationPrompt,
  explanationRecord,
  parseExplanationOutput,
  planExplanation,
  type ExplanationAgent,
  type ExplanationSource,
  type ParsedExplanation,
  type StoredExplanationFile,
} from '../core/explanations';
import { isBinaryPatch } from '../core/diff';
import type { ChangedFile } from '../core/gitParsing';
import { shortHash, uncommittedLabel } from '../core/presentation';
import { AgentCliError, runAgent } from '../git/agentCli';
import { isGitOutputLimitError, type GitClient } from '../git/client';
import type { ExplanationRead, ExplanationStore } from '../git/explanationStore';
import { errorMessage, showError, showInfo, showStatus } from './common';
import type { ExplanationPermissions } from './explanationPermissions';
import { explanationAgentSetting } from './explanationSettings';
import type { RepositoryAccess } from './repositories';

const DIFF_CONCURRENCY = 8;
export const NO_CHANGED_FILES = '変更ファイルがありません';
export const RESET_EXPLANATION_PERMISSIONS_TITLE = 'VSReview: 解説のための差分送信の許可・拒否をリセット';

export interface ReviewExplanationsDependencies {
  access: Pick<RepositoryAccess, 'client'>;
  store: Pick<ExplanationStore, 'has' | 'load' | 'read' | 'write'>;
  permissions: Pick<ExplanationPermissions, 'allowed' | 'denied'>;
  run?: typeof runAgent;
  agent?: () => ExplanationAgent;
}

// 比較の保存済みの解説の読み込み状態。failed は読み込み自体が失敗した場合（権限など）。
export type ExplanationRecordState = ExplanationRead | { kind: 'loading' } | { kind: 'failed'; message: string };
export interface ExplanationQuery {
  record: ExplanationRecordState;
  // record が found のとき、そのパスの解説または解説なしの理由。記録にないパスでは undefined。
  file?: StoredExplanationFile;
  generating: boolean;
  failure?: string;
}

export function explanationTargetLabel(target: CommitTarget): string {
  return target.uncommitted
    ? uncommittedLabel(target.uncommitted.kind)
    : target.pullRequest
      ? `PR #${target.pullRequest.number}`
      : shortHash(target.commit.hash);
}

function parsedCounts(parsed: ParsedExplanation): string | undefined {
  const parts = [
    parsed.ignored ? `依頼していない ${parsed.ignored} 件を捨てました` : '',
    parsed.missing.length ? `${parsed.missing.length} 件は出力に含まれませんでした` : '',
    parsed.invalid.length ? `${parsed.invalid.length} 件は出力が不正でした` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('、') : undefined;
}

// 比較の変更ファイルの diff をエージェント CLI に渡し、ファイルごとの解説を保存する。
export class ReviewExplanations implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  // 費用と端末の負荷を抑えるため、生成は 1 件ずつ実行する。
  private readonly queue = new SerialQueue();
  private readonly pending = new PromiseCache<void>();
  private readonly generatingKeys = new Set<string>();
  // リポジトリごとの比較の最後の失敗。load で破棄する。
  private readonly failures = new Map<string, Map<string, string>>();
  // リポジトリごとの索引の読み込み。進行中・完了済みの読み込みを共有する。
  private readonly loads = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  // ツリーとビューが同期的に引けるよう、読み込んだ比較の記録をリポジトリごとに持つ。
  private readonly records = new Map<string, Map<string, ExplanationRecordState>>();
  private disposed = false;
  private readonly run: typeof runAgent;
  private readonly agent: () => ExplanationAgent;
  constructor(private readonly dependencies: ReviewExplanationsDependencies) {
    this.run = dependencies.run ?? runAgent;
    this.agent = dependencies.agent ?? explanationAgentSetting;
  }
  // 比較に保存済みの解説があるかを返す。load の前は false。
  has(target: CommitTarget): boolean {
    return this.dependencies.store.has(target.repo, comparisonKey(target));
  }
  isGenerating(target: CommitTarget): boolean {
    return this.generatingKeys.has(comparisonKey(target));
  }
  failure(target: CommitTarget): string | undefined {
    return this.failures.get(target.repo)?.get(comparisonKey(target));
  }
  // 索引を読み直し、読み込み済みの記録と失敗の記録を破棄する。
  load(repo: string): Promise<void> {
    const loading = (async () => {
      await this.dependencies.store.load(repo);
      this.records.delete(repo);
      this.failures.delete(repo);
      if (!this.disposed) {
        this.changed.fire();
      }
    })();
    this.loads.set(repo, loading);
    // 失敗した読み込みは共有せず、次の呼び出しで読み直す。
    loading.catch(() => {
      if (this.loads.get(repo) === loading) {
        this.loads.delete(repo);
      }
    });
    return loading;
  }
  // 索引の読み込みが終わるのを待つ。未読み込みなら読み込み、進行中なら共有する。
  ensureLoaded(repo: string): Promise<void> {
    return this.loads.get(repo) ?? this.load(repo);
  }
  // 比較とパスの解説・生成中・最後の失敗を返す。未読み込みなら読み込みを始め、終わったら変更を通知する。
  explanation(target: CommitTarget, path: string): ExplanationQuery {
    const key = comparisonKey(target);
    const record = this.record(target.repo, key);
    const file = record.kind === 'found' ? record.explanation.files.find((entry) => entry.path === path) : undefined;
    const failure = this.failures.get(target.repo)?.get(key);
    return {
      record,
      ...(file ? { file } : {}),
      generating: this.generatingKeys.has(key),
      ...(failure === undefined ? {} : { failure }),
    };
  }
  // ツリー用。解説（markdown）があるファイルだけ true。解説なしの理由だけのファイルは false。
  explained(target: CommitTarget, path: string): boolean {
    const { file } = this.explanation(target, path);
    return file !== undefined && 'markdown' in file;
  }
  private record(repo: string, key: string): ExplanationRecordState {
    const records = this.records.get(repo) ?? new Map<string, ExplanationRecordState>();
    this.records.set(repo, records);
    const cached = records.get(key);
    if (cached) {
      return cached;
    }
    // 保存のない比較は読みに行かない。
    if (!this.dependencies.store.has(repo, key)) {
      return { kind: 'none' };
    }
    const loading = { kind: 'loading' } as const;
    records.set(key, loading);
    void this.dependencies.store.read(repo, key).then(
      (read) => this.settle(repo, key, loading, read),
      (error: unknown) => {
        // 失敗は一度だけ通知し、次の load・生成まで読み直さない。無効になった読み込みの失敗は通知しない。
        if (this.settle(repo, key, loading, { kind: 'failed', message: errorMessage(error) })) {
          showError(error);
        }
      },
    );
    return loading;
  }
  private settle(repo: string, key: string, loading: ExplanationRecordState, state: ExplanationRecordState): boolean {
    const records = this.records.get(repo);
    // 読み込み中に load・生成で記録が入れ替わっていれば、古い結果を入れない。
    if (this.disposed || records?.get(key) !== loading) {
      return false;
    }
    records.set(key, state);
    this.changed.fire();
    return true;
  }
  // 比較のオブジェクト（PR の head・merge-base、未コミットのスナップショット）は呼び出し側で取得済みとする。
  // 同じ比較の生成中に呼ばれたら、その生成の完了を待つ。再生成は成功したときだけ既存の解説を置き換える。
  generate(target: CommitTarget, files: readonly ChangedFile[]): Promise<void> {
    const key = comparisonKey(target);
    if (this.disposed) {
      return Promise.resolve();
    }
    let started = false;
    const generation = this.pending.get(key, () => {
      started = true;
      this.generatingKeys.add(key);
      return this.queue.run(async () => {
        try {
          await this.generateNow(target, files, key);
        } finally {
          this.pending.delete(key);
          this.generatingKeys.delete(key);
          if (!this.disposed) {
            this.changed.fire();
          }
        }
      });
    });
    // 登録してから通知し、購読側が同じ比較の生成を呼んでも登録済みの生成を返して通知を繰り返さない。
    if (started) {
      this.changed.fire();
    }
    return generation;
  }
  private async generateNow(target: CommitTarget, files: readonly ChangedFile[], key: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!files.length) {
      showInfo(NO_CHANGED_FILES);
      return;
    }
    // 許可の確認中に dispose されても中断として扱えるよう、確認より前に作る。
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const agent = this.agent();
      if (!(await this.dependencies.permissions.allowed(target.repo, agent))) {
        if (!controller.signal.aborted && (await this.dependencies.permissions.denied(target.repo, agent))) {
          showInfo(`${agent} への差分の送信を拒否しています。「${RESET_EXPLANATION_PERMISSIONS_TITLE}」で選び直せます`);
        }
        return;
      }
      // 確認の応答を待つ間に破棄されたら、差分を取得せず送らない。
      if (controller.signal.aborted) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `VSReview: ${explanationTargetLabel(target)} の解説を生成しています`,
          cancellable: true,
        },
        async (_progress, token) => {
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            await this.explain(target, files, key, agent, controller.signal);
          } finally {
            cancellation.dispose();
          }
        },
      );
      this.failures.get(target.repo)?.delete(key);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof AgentCliError && error.failure === 'aborted')) {
        if (!this.disposed) {
          showStatus('解説の生成を中断しました');
        }
        return;
      }
      const failures = this.failures.get(target.repo) ?? new Map<string, string>();
      failures.set(key, errorMessage(error));
      this.failures.set(target.repo, failures);
      showError(error);
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async explain(
    target: CommitTarget,
    files: readonly ChangedFile[],
    key: string,
    agent: ExplanationAgent,
    signal: AbortSignal,
  ): Promise<void> {
    const git = this.dependencies.access.client(target.repo);
    const sources: ExplanationSource[] = new Array<ExplanationSource>(files.length);
    await forEachConcurrent(
      files.map((file, index) => ({ file, index })),
      DIFF_CONCURRENCY,
      async ({ file, index }) => {
        // 取り消し後は未着手のファイルの取得を始めない。
        signal.throwIfAborted();
        sources[index] = await this.source(git, target, file, signal);
      },
    );
    signal.throwIfAborted();
    const plan = planExplanation(sources);
    let parsed: ParsedExplanation = { markdown: new Map(), missing: [], invalid: [], ignored: 0 };
    // 送れるファイルがなければ CLI を起動せず、省略理由だけを保存する。
    if (plan.requests.length) {
      const output = await this.run(agent, explanationPrompt(plan.requests), { signal });
      parsed = parseExplanationOutput(
        output,
        plan.requests.map(({ id }) => id),
      );
    }
    // CLI の終了後・保存前の取り消しでは、出力があっても保存しない。
    signal.throwIfAborted();
    const counts = parsedCounts(parsed);
    // 送ったのに有効な解説が 1 件もなければ、既存の解説を欠けた記録で上書きしないよう失敗にする。
    if (plan.requests.length && !parsed.markdown.size) {
      throw new Error(`解説が 1 件も得られませんでした${counts ? `（${counts}）` : ''}`);
    }
    await this.dependencies.store.write(
      target.repo,
      explanationRecord(plan, parsed, { comparison: key, agent, generatedAt: new Date().toISOString() }),
    );
    // 件数の上限で消えた比較もあるので、そのリポジトリの記録を読み直す。
    this.records.delete(target.repo);
    showStatus(counts ? `解説を保存しました（${counts}）` : '解説を保存しました');
  }
  private async source(
    git: GitClient,
    target: CommitTarget,
    file: ChangedFile,
    signal: AbortSignal,
  ): Promise<ExplanationSource> {
    // サブモジュールは差分を開く処理と同じ判定で外す。
    if (await git.isSubmoduleChange(target.parent, target.commit.hash, file)) {
      return { ...file, skipped: 'submodule' };
    }
    signal.throwIfAborted();
    let patch: string;
    try {
      patch = await git.patch(target.parent, target.commit.hash, file);
    } catch (error) {
      if (isGitOutputLimitError(error)) {
        return { ...file, skipped: 'tooLarge' };
      }
      throw error;
    }
    return isBinaryPatch(patch) || patch.includes('\0') ? { ...file, skipped: 'binary' } : { ...file, diff: patch };
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.changed.dispose();
  }
}
