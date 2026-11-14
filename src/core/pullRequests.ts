import { hasStrings, isRecord, isRevision, isPositiveInteger } from './validation';

export const PULL_REQUEST_REOPEN = '一覧を更新して PR を開き直してください';
export const PULL_REQUEST_REVISION_CHANGED = `PR のリビジョンが変わりました。${PULL_REQUEST_REOPEN}`;
export const PULL_REQUEST_REMOTE = 'origin';
export const PULL_REQUEST_FIELDS =
  'number,title,author,baseRefName,headRefName,baseRefOid,headRefOid,url,isCrossRepository,updatedAt,state,headRepository,headRepositoryOwner';
export interface PullRequest {
  number: number;
  title: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  baseRefOid: string;
  headRefOid: string;
  url: string;
  isCrossRepository: boolean;
  updatedAt: string;
  // 追加前の保存コメントには存在しない。取得時は parsePullRequest で必須にする。
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  headRepository?: { name: string } | null;
  headRepositoryOwner?: { login: string } | null;
}
export interface PullRequestReview extends PullRequest {
  mergeBase: string;
}
export function isPullRequest(value: unknown): value is PullRequest {
  return (
    isRecord(value) &&
    isPositiveInteger(value.number) &&
    hasStrings(value, ['title', 'baseRefName', 'headRefName', 'url', 'updatedAt']) &&
    Boolean(value.baseRefName) &&
    Boolean(value.headRefName) &&
    isRevision(value.baseRefOid) &&
    isRevision(value.headRefOid) &&
    isRecord(value.author) &&
    typeof value.author.login === 'string' &&
    typeof value.isCrossRepository === 'boolean' &&
    (value.state === undefined ||
      (typeof value.state === 'string' && ['OPEN', 'CLOSED', 'MERGED'].includes(value.state))) &&
    (value.headRepository == null ||
      (isRecord(value.headRepository) && typeof value.headRepository.name === 'string')) &&
    (value.headRepositoryOwner == null ||
      (isRecord(value.headRepositoryOwner) && typeof value.headRepositoryOwner.login === 'string'))
  );
}
export function isPullRequestReview(value: unknown): value is PullRequestReview {
  return isPullRequest(value) && 'mergeBase' in value && isRevision(value.mergeBase);
}
function isFetchedPullRequest(value: unknown): value is PullRequest {
  return (
    isPullRequest(value) &&
    value.state !== undefined &&
    value.headRepository !== undefined &&
    value.headRepositoryOwner !== undefined
  );
}
export function parsePullRequests(json: string): PullRequest[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every(isFetchedPullRequest)) {
    throw new Error('gh の Pull Request 一覧の形式が不正です');
  }
  return value;
}
export function parsePullRequest(json: string): PullRequest {
  const value: unknown = JSON.parse(json);
  if (!isFetchedPullRequest(value)) {
    throw new Error('gh の Pull Request の形式が不正です');
  }
  return value;
}
export function isPullRequestRewritten(savedHead: string, latestOpenHead: string, isAncestor: boolean): boolean {
  return savedHead !== latestOpenHead && !isAncestor;
}

export type PullRequestComparison = Pick<PullRequestReview, 'number' | 'headRefOid' | 'mergeBase'> & {
  isCrossRepository?: boolean;
};
export function pullRequestComparison(value: PullRequestComparison): PullRequestComparison {
  return {
    number: value.number,
    headRefOid: value.headRefOid,
    mergeBase: value.mergeBase,
    ...(value.isCrossRepository === undefined ? {} : { isCrossRepository: value.isCrossRepository }),
  };
}
export function isPullRequestComparison(value: unknown): value is PullRequestComparison {
  return (
    isRecord(value) &&
    isPositiveInteger(value.number) &&
    isRevision(value.headRefOid) &&
    isRevision(value.mergeBase) &&
    (value.isCrossRepository === undefined || typeof value.isCrossRepository === 'boolean')
  );
}
export function isPullRequestComparisonFor(value: unknown, commit: unknown, parent: unknown): boolean {
  return (
    value === undefined || (isPullRequestComparison(value) && value.headRefOid === commit && value.mergeBase === parent)
  );
}
export function parseOpenPullRequestHead(json: string): string | undefined {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    !(typeof value.state === 'string' && ['OPEN', 'CLOSED', 'MERGED'].includes(value.state)) ||
    !isRevision(value.headRefOid)
  ) {
    throw new Error('gh の Pull Request head の形式が不正です');
  }
  return value.state === 'OPEN' ? value.headRefOid : undefined;
}

function repositoryIdentity(url: string): string | undefined {
  try {
    // URL パーサーが扱えない scp 形式を SSH URL に直してからリポジトリを比較する。
    const parsed = new URL(url.replace(/^([^/@]+@)?([^/:]+):(?=[^/])/, 'ssh://$1$2/'));
    return `${parsed.hostname}${parsed.pathname
      .replace(/\/pull\/\d+\/?$/, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '')}`.toLowerCase();
  } catch {
    return undefined;
  }
}
export function matchingPullRequestRemote(
  remotes: readonly { name: string; url: string }[],
  url: string,
): string | undefined {
  const identity = repositoryIdentity(url);
  const matches = remotes.filter((remote) => identity !== undefined && repositoryIdentity(remote.url) === identity);
  return matches.find((remote) => remote.name === PULL_REQUEST_REMOTE)?.name ?? matches[0]?.name;
}
