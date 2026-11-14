import { ReviewDocuments } from '../src/ui/documents';
import { RevisionArchives } from '../src/ui/revisionArchives';
import { RevisionSnapshots } from '../src/ui/revisionSnapshots';
import { type GhFactory, GhClient } from '../src/git/gh';
import type { CommitTarget } from '../src/core/documents';
import { PullRequestCommands } from '../src/ui/pullRequestCommands';
import { PullRequestReviews } from '../src/ui/pullRequestReviews';
import { PullRequestsTree } from '../src/ui/pullRequests';
import { ChangedFiles, RepositoryAccess } from '../src/ui/repositories';
import { pullRequestRemoteSetting } from '../src/ui/pullRequestSettings';
import childProcess from 'node:child_process';
import type { WorkspaceFolder, Memento, ExtensionContext, Disposable } from 'vscode';
import type { ReviewComment } from '../src/core/model';
import { syncBuiltinESMExports } from 'node:module';
import { GitClient, runGit, type GitFactory } from '../src/git/client';
import { Uri, resetVscode, settleRangeRequests } from './vscodeMock';
import { join } from 'node:path';
import { commitAll, createRepository, createTemporaryDirectory, TEST_AUTHOR } from './gitFixtures';
import { writeFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, vi } from 'vitest';
const disposables: (() => void | Promise<void>)[] = [];
beforeEach(resetVscode);
afterEach(async () => {
  try {
    await settleRangeRequests();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const dispose of disposables.splice(0)) {
      await dispose();
    }
  }
});
export async function repository(): Promise<Awaited<ReturnType<typeof createRepository>>> {
  const fixture = await createRepository();
  disposables.push(fixture.dispose);
  return fixture;
}
export const reviewComment: ReviewComment = {
  id: 'one',
  repoRoot: '/repo',
  commit: 'b'.repeat(40),
  parent: 'a'.repeat(40),
  path: '新 name.ts',
  oldPath: 'old.ts',
  status: 'R',
  side: 'new',
  startLine: 3,
  endLine: 4,
  code: 'new\nextra',
  hunkHeader: '@@ -2,3 +2,4 @@ function x',
  excerpt: '> +new\n> +extra',
  body: '境界値を確認してください',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  resolved: false,
  subject: 'subject',
  author: TEST_AUTHOR,
  date: '2026-01-01T00:00:00Z',
};

export async function accessFor(
  directory: string,
  factory: GitFactory = (repo) => new GitClient(repo),
): Promise<RepositoryAccess> {
  const access = new RepositoryAccess(factory);
  await access.discover([workspaceFolder(directory)]);
  return access;
}
export async function temporaryDirectory(): Promise<string> {
  const path = await createTemporaryDirectory();
  disposables.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

export class MemoryState implements Memento {
  value: unknown;
  writes: unknown[] = [];
  fail = false;
  get<T>(): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(_key?: string, defaultValue?: T): T | undefined {
    return (this.value ?? defaultValue) as T | undefined;
  }
  keys(): string[] {
    return [];
  }
  async update(_key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (this.fail) {
      this.fail = false;
      throw new Error('disk full');
    }
    this.value = value;
    this.writes.push(value);
  }
}

export class KeyedState implements Memento {
  private readonly values = new Map<string, unknown>();
  keys(): string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.get(key) ?? defaultValue) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

export function extensionContext(
  state: Memento = new MemoryState(),
  options: Pick<Partial<ExtensionContext>, 'storageUri'> = {},
): ExtensionContext {
  const subscriptions: Disposable[] = [];
  disposables.push(() => {
    for (const resource of [...subscriptions].reverse()) {
      resource.dispose();
    }
  });
  return { subscriptions, workspaceState: state, ...options } as ExtensionContext;
}
export function disposeAfter(resource: Disposable): void {
  disposables.push(() => {
    resource.dispose();
  });
}

export function workspaceFolder(path: string, index = 0): WorkspaceFolder {
  return { uri: Uri.file(path), name: String(index), index } as WorkspaceFolder;
}
export const ASYNC_TEST_TIMEOUT_MS = 10000;
export function waitFor(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: ASYNC_TEST_TIMEOUT_MS });
}

export function gitProcesses() {
  const spy = vi.spyOn(childProcess, 'execFile');
  syncBuiltinESMExports();
  return spy;
}

export const pullRequest = {
  state: 'OPEN' as const,
  headRepository: { name: 'repo' },
  headRepositoryOwner: { login: 'contributor' },
  number: 12,
  title: '境界値',
  author: { login: 'reviewer' },
  baseRefName: 'main',
  headRefName: 'topic',
  baseRefOid: 'a'.repeat(40),
  headRefOid: 'b'.repeat(40),
  url: 'https://github.com/example/repo/pull/12',
  isCrossRepository: true,
  updatedAt: '2026-11-09T00:00:00Z',
};
export const pullRequestReview = { ...pullRequest, mergeBase: 'a'.repeat(40) };

export async function pullRequestRepository() {
  const { directory: source, git: sourceGit } = await repository();
  await writeFile(join(source, 'file'), 'base\n');
  await commitAll(source, 'base');
  const base = (await sourceGit.head())!;
  await runGit(source, ['checkout', '-b', 'topic']);
  await writeFile(join(source, 'file'), 'head\n');
  await commitAll(source, 'head');
  const head = (await sourceGit.head())!;
  const origin = await temporaryDirectory();
  await runGit(origin, ['init', '--bare']);
  await runGit(source, ['remote', 'add', 'origin', origin]);
  await runGit(source, ['push', 'origin', 'main', `${head}:refs/pull/12/head`]);
  const directory = await temporaryDirectory();
  await runGit(directory, ['init']);
  await runGit(directory, ['remote', 'add', 'origin', origin]);
  const git = new GitClient(directory);
  const repositoryPullRequest = { ...pullRequest, baseRefOid: base, headRefOid: head };
  const saved = {
    ...reviewComment,
    repoRoot: directory,
    commit: head,
    parent: base,
    path: 'file',
    status: 'M' as const,
    pullRequest: { ...repositoryPullRequest, mergeBase: base },
  };
  delete saved.oldPath;
  return { source, sourceGit, origin, directory, git, base, head, pullRequest: repositoryPullRequest, saved };
}

// 単体テストでは実 gh への接続を禁止する。
export const unexpectedGh: GhFactory = (repo) =>
  new GhClient(repo, () => Promise.reject(new Error('予期しない gh 呼び出し')));
const treeCommands = new WeakMap<PullRequestsTree, PullRequestCommands>();
export function pullRequestCommandsFor(tree: PullRequestsTree): PullRequestCommands {
  const commands = treeCommands.get(tree);
  if (!commands) {
    throw new Error('テスト用 PR コマンドが未登録です');
  }
  return commands;
}
const treeReviews = new WeakMap<PullRequestsTree, PullRequestReviews>();
export function reviewsFor(tree: PullRequestsTree): PullRequestReviews {
  const reviews = treeReviews.get(tree);
  if (!reviews) {
    throw new Error('テスト用 PR 表示情報が未登録です');
  }
  return reviews;
}
export function registerPullRequestsTree(
  selection: { readonly git: GitClient | undefined },
  changed: ChangedFiles,
  options: {
    comments?: () => readonly ReviewComment[];
    openTargets?: () => Promise<readonly CommitTarget[]>;
    gh?: GhFactory;
  },
) {
  const gh = options.gh ?? unexpectedGh;
  const comments = options.comments ?? (() => []);
  const remote = () => pullRequestRemoteSetting();
  const reviews = new PullRequestReviews(comments, options.openTargets ?? (() => Promise.resolve([])), {
    gh: gh,
    remote: remote,
  });
  disposeAfter(reviews);
  const tree = PullRequestsTree.register(selection, changed, { comments, source: { gh, remote }, reviews });
  treeReviews.set(tree, reviews);
  treeCommands.set(tree, new PullRequestCommands(tree, changed, { gh, remote }, reviews));
  return tree;
}

export const archiveLease = { withLease: <T>(action: () => Promise<T>): Promise<T> => action() };
export function revisionArchives(access: RepositoryAccess): RevisionArchives {
  return RevisionArchives.create(
    extensionContext(new KeyedState()),
    access,
    new RevisionSnapshots(access, new ChangedFiles(access)),
  );
}
export function reviewDocuments(access: RepositoryAccess): ReviewDocuments {
  return new ReviewDocuments(access, revisionArchives(access));
}
export function revisionSnapshots(access: RepositoryAccess, changed = new ChangedFiles(access)): RevisionSnapshots {
  return new RevisionSnapshots(access, changed);
}

const ARCHIVE_CLOCK_STEP_MS = 1000;
export function archiveClock(): void {
  let time = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => (time += ARCHIVE_CLOCK_STEP_MS));
}
