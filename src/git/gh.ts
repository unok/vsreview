import { COMMAND_MAX_BUFFER_BYTES, commandEnvironment } from './environment';
import { execFile } from 'node:child_process';
import { ghExecutable } from './executable.mts';
import {
  PULL_REQUEST_FIELDS,
  parsePullRequest,
  parsePullRequests,
  type PullRequest,
  parseOpenPullRequestHead,
} from '../core/pullRequests';
import { isPositiveInteger } from '../core/validation';

export type GhExecutor = (repo: string, args: readonly string[]) => Promise<string>;
// 未応答でも自動更新を再開できるよう、通常の API 待ちには30秒で区切りを付ける。
export const GH_TIMEOUT_MS = 30_000;
export const runGh: GhExecutor = (repo, args) =>
  new Promise((done, reject) => {
    const env = commandEnvironment();
    // cwd と異なるリポジトリへ gh が向かないよう、外部からの指定を除く。
    delete env.GH_REPO;
    const child = execFile(
      ghExecutable(),
      [...args],
      {
        cwd: repo,
        timeout: GH_TIMEOUT_MS,
        env: { ...env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
        windowsHide: true,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh: ${stderr.trim() || error.message}`));
        } else {
          done(stdout);
        }
      },
    );
    child.stdin?.on('error', () => {
      /* 実行失敗は execFile のコールバックで通知する。 */
    });
    child.stdin?.end();
  });
export class GhClient {
  constructor(
    readonly root: string,
    private readonly execute: GhExecutor = runGh,
  ) {}
  async list(limit: number): Promise<PullRequest[]> {
    assertPositiveInteger(limit);
    return parsePullRequests(
      await this.execute(this.root, [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        String(limit),
        '--json',
        PULL_REQUEST_FIELDS,
      ]),
    );
  }
  async view(number: number): Promise<PullRequest> {
    assertPositiveInteger(number);
    return parsePullRequest(
      await this.execute(this.root, ['pr', 'view', String(number), '--json', PULL_REQUEST_FIELDS]),
    );
  }
  async viewOpenHead(number: number): Promise<string | undefined> {
    assertPositiveInteger(number);
    return parseOpenPullRequestHead(
      await this.execute(this.root, ['pr', 'view', String(number), '--json', 'headRefOid,state']),
    );
  }
}
function assertPositiveInteger(value: number): void {
  if (!isPositiveInteger(value)) {
    throw new Error('正の整数を入力してください');
  }
}

export type GhFactory = (repo: string) => GhClient;
export interface PullRequestSource {
  gh: GhFactory;
  remote: () => string;
}
