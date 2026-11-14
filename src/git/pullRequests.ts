import {
  PULL_REQUEST_REVISION_CHANGED,
  PULL_REQUEST_REOPEN,
  PULL_REQUEST_REMOTE,
  isPullRequestRewritten,
  matchingPullRequestRemote,
  pullRequestComparison,
  type PullRequest,
  type PullRequestComparison,
} from '../core/pullRequests';
import { GitError, type GitClient } from './client';
import type { GhClient } from './gh';
import { canonicalCommit, type CommitTarget } from '../core/documents';

async function ensurePullRequestObjects(
  git: GitClient,
  pullRequest: Pick<PullRequest, 'number' | 'headRefOid' | 'baseRefOid' | 'baseRefName' | 'url'>,
  configured = PULL_REQUEST_REMOTE,
): Promise<void> {
  if ((await git.hasCommit(pullRequest.baseRefOid)) && (await git.hasCommit(pullRequest.headRefOid))) {
    return;
  }
  const remote = await resolvePullRequestRemote(git, pullRequest, configured);
  let baseFetchError: GitError | undefined;
  if (!(await git.hasCommit(pullRequest.baseRefOid))) {
    try {
      await git.fetch(remote, pullRequest.baseRefOid);
    } catch (error) {
      if (
        !(error instanceof GitError) ||
        !/not our ref|unadvertised object|couldn't find remote ref/i.test(error.stderr)
      ) {
        throw error;
      }
      baseFetchError = error;
      // 未広告の OID を拒否するサーバーでは、検証済みのブランチ名から取得する。
      git.assertBranchName(pullRequest.baseRefName);
      try {
        await git.fetch(remote, `refs/heads/${pullRequest.baseRefName}`);
      } catch (fallbackError) {
        throw new Error(
          `${error.message}; ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }
  }
  if (!(await git.hasCommit(pullRequest.headRefOid))) {
    await fetchPullRequestHead(git, pullRequest, remote);
  }
  if (!(await git.hasCommit(pullRequest.baseRefOid))) {
    throw new Error(`${baseFetchError ? `${baseFetchError.message}; ` : ''}${PULL_REQUEST_REVISION_CHANGED}`);
  }
}
export async function preparePullRequest(
  git: GitClient,
  pullRequest: PullRequest,
  configured = PULL_REQUEST_REMOTE,
): Promise<CommitTarget> {
  await ensurePullRequestObjects(git, pullRequest, configured);
  const parent = await git.mergeBase(pullRequest.baseRefOid, pullRequest.headRefOid).catch((error: unknown) => {
    if (error instanceof GitError && error.exitCode === 1) {
      throw new Error('PR の base と head に共通の祖先がありません');
    }
    throw error;
  });
  return {
    repo: git.root,
    parent,
    pullRequest: pullRequestComparison({
      number: pullRequest.number,
      isCrossRepository: pullRequest.isCrossRepository,
      headRefOid: pullRequest.headRefOid,
      mergeBase: parent,
    }),
    commit: canonicalCommit(
      { hash: pullRequest.headRefOid, subject: '', author: '', date: '' },
      parent,
      pullRequest.number,
    ),
  };
}

export async function resolvePullRequestRemote(
  git: GitClient,
  pullRequest: Pick<PullRequest, 'url'>,
  configured = PULL_REQUEST_REMOTE,
): Promise<string> {
  const remotes = await git.remotes();
  const selected =
    configured === PULL_REQUEST_REMOTE
      ? (matchingPullRequestRemote(remotes, pullRequest.url) ?? configured)
      : configured;
  if (!remotes.some((remote) => remote.name === selected)) {
    throw new Error(`PR の取得先リモートがありません: ${configured}`);
  }
  return selected;
}

export async function restorePullRequestComparison(
  git: GitClient,
  comparison: PullRequestComparison,
  configured: string,
  gh: GhClient,
  savedReview?: Pick<PullRequest, 'url'>,
): Promise<void> {
  if ((await git.hasCommit(comparison.headRefOid)) && (await git.hasCommit(comparison.mergeBase))) {
    return;
  }
  // 保存コメントの URL があれば gh の導入・認証状態に依存せず復元する。
  const source = savedReview ?? (await gh.view(comparison.number));
  const remote = await resolvePullRequestRemote(git, source, configured);
  if (!(await git.hasCommit(comparison.headRefOid))) {
    await fetchPullRequestHead(git, { number: comparison.number, headRefOid: comparison.headRefOid }, remote).catch(
      async () => {
        try {
          await git.fetch(remote, comparison.headRefOid);
        } catch (error) {
          throw new Error(
            `保存した PR の head を取得できません: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    );
  }
  if (!(await git.hasCommit(comparison.mergeBase))) {
    throw new Error(`保存した PR の merge-base を取得できません。${PULL_REQUEST_REOPEN}`);
  }
}

export async function ensurePullRequestHead(
  git: GitClient,
  pullRequest: Pick<PullRequest, 'number' | 'headRefOid' | 'url'>,
  configured = PULL_REQUEST_REMOTE,
): Promise<void> {
  if (await git.hasCommit(pullRequest.headRefOid)) {
    return;
  }
  const remote = await resolvePullRequestRemote(git, pullRequest, configured);
  await fetchPullRequestHead(git, pullRequest, remote);
}

async function fetchPullRequestHead(
  git: GitClient,
  pullRequest: Pick<PullRequest, 'number' | 'headRefOid'>,
  remote: string,
): Promise<void> {
  await git.fetch(remote, `refs/pull/${pullRequest.number}/head`);
  if (!(await git.hasCommit(pullRequest.headRefOid))) {
    throw new Error(PULL_REQUEST_REVISION_CHANGED);
  }
}

// undefined は判定材料が取得できず、直前の判定を維持すべき状態を表す。
export async function detectPullRequestRewritten(
  git: GitClient,
  saved: PullRequestComparison,
  latest: string | undefined,
): Promise<boolean | undefined> {
  if (!latest || !(await git.hasCommit(latest))) {
    return undefined;
  }
  const ancestor = (await git.hasCommit(saved.headRefOid)) && (await git.isAncestor(saved.headRefOid, latest));
  return isPullRequestRewritten(saved.headRefOid, latest, ancestor);
}
