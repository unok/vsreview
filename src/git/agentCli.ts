import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPLANATION_MARKDOWN_MAX_BYTES, type ExplanationAgent } from '../core/explanations';
import { replaceDisplayControls } from '../core/presentation';
import { resolveExecutable } from './executable.mts';

// 生成は数分かかるため、Git や gh より長く待つ。
export const AGENT_TIMEOUT_MS = 10 * 60_000;
// 上限の大きさの解説 256 件分に相当する大きさ。これを超える出力は不正として止める。
export const AGENT_OUTPUT_MAX_BYTES = 256 * EXPLANATION_MARKDOWN_MAX_BYTES;
// 停止を求めてから強制終了するまでの猶予。
export const AGENT_KILL_GRACE_MS = 5_000;
// 非ゼロ終了の後、標準エラーの残りを待つ時間。
const AGENT_FAILURE_DRAIN_MS = 1_000;
const STDERR_TAIL_LENGTH = 1000;
const STDERR_KEEP_BYTES = 16 * 1024;

// エージェントごとの引数はここだけで決める。ツールを持たせず、設定・フック・MCP を読ませない。
export const AGENT_ARGUMENTS: Readonly<Record<ExplanationAgent, readonly string[]>> = {
  claude: [
    '-p',
    '--safe-mode',
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--permission-prompts',
    'none',
    '--output-format',
    'text',
  ],
};

export type AgentFailure = 'spawn' | 'exit' | 'timeout' | 'outputLimit' | 'aborted';
export class AgentCliError extends Error {
  constructor(
    readonly failure: AgentFailure,
    message: string,
  ) {
    super(message);
  }
}
export interface AgentRunOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxOutputBytes?: number;
  killGrace?: number;
}

function stderrTail(stderr: Buffer): string {
  // 制御文字で端末や通知の表示を崩さないよう、空白に置き換える。
  return replaceDisplayControls(stderr.toString('utf8').trim().slice(-STDERR_TAIL_LENGTH), () => ' ');
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function abortedError(agent: ExplanationAgent): AgentCliError {
  return new AgentCliError('aborted', `${agent} の実行を中断しました`);
}

// プロンプトを標準入力で渡し、標準出力を返す。作業ディレクトリは空の一時ディレクトリにして、リポジトリの設定を読ませない。
export async function runAgent(
  agent: ExplanationAgent,
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  if (options.signal?.aborted) {
    throw abortedError(agent);
  }
  let executable: string;
  let cwd: string;
  try {
    // PATH への導入後に再起動なしで使えるよう、実行のたびに解決する。
    executable = resolveExecutable(agent);
    cwd = await mkdtemp(join(tmpdir(), 'vsreview-agent-'));
  } catch (error) {
    throw new AgentCliError('spawn', errorMessage(error));
  }
  let outcome: { output: string } | { error: unknown };
  try {
    // 一時ディレクトリを作る間に中断された場合は起動しない。
    if (options.signal?.aborted) {
      throw abortedError(agent);
    }
    outcome = { output: await execute(agent, executable, cwd, prompt, options) };
  } catch (error) {
    outcome = { error };
  }
  try {
    await rm(cwd, { recursive: true, force: true });
  } catch (error) {
    // 実行も失敗している場合は、呼び出し元が失敗の種類を見分けられるよう元の失敗を返す。
    if ('output' in outcome) {
      throw error;
    }
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.output;
}

function execute(
  agent: ExplanationAgent,
  executable: string,
  cwd: string,
  prompt: string,
  options: AgentRunOptions,
): Promise<string> {
  return new Promise<string>((done, reject) => {
    const child = spawn(executable, [...AGENT_ARGUMENTS[agent]], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = Buffer.alloc(0);
    let stopped: AgentCliError | undefined;
    let inputError: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    // execFile の timeout・signal・maxBuffer では外部からのシグナルによる終了と見分けられず、
    // 子プロセスの終了を待たずに失敗が届くため、停止の理由を記録して終了を待つ。
    const stop = (reason: AgentCliError): void => {
      if (stopped) {
        return;
      }
      stopped = reason;
      if (child.exitCode !== null || child.signalCode !== null) {
        release();
        return;
      }
      child.kill('SIGTERM');
      // SIGTERM を無視する CLI も猶予の後に終了させる。
      killTimer = setTimeout(() => child.kill('SIGKILL'), options.killGrace ?? AGENT_KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => stop(new AgentCliError('timeout', `${agent} の応答が時間内に終わりませんでした`)),
      options.timeout ?? AGENT_TIMEOUT_MS,
    );
    // CLI 本体が終わっても、出力を継承した子孫がパイプを開いたままだと close が届かない。
    // 停止を求めた後は本体の終了を確かめた時点で読み取りを打ち切る。正常終了では出力を最後まで読む。
    const release = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    child.once('exit', (code) => {
      if (stopped) {
        release();
      } else if (code !== 0) {
        // 失敗した CLI の子孫がパイプを開いたままでも、標準エラーを少し待ってから終了コードを返す。
        drainTimer = setTimeout(release, AGENT_FAILURE_DRAIN_MS);
      }
    });
    const abort = (): void => stop(abortedError(agent));
    options.signal?.addEventListener('abort', abort, { once: true });
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', abort);
      // 停止後に CLI が終了コード 0 で終わっても、期限後や中断後の出力は採用しない。
      if (stopped) {
        reject(stopped);
      } else if (spawnError) {
        reject(new AgentCliError('spawn', `${agent} を起動できませんでした: ${spawnError.message}`));
      } else if (code !== 0) {
        const tail = stderrTail(stderr);
        reject(
          new AgentCliError(
            'exit',
            `${agent} が${signal ? `シグナル ${signal}` : `終了コード ${String(code)}`} で失敗しました${tail ? `: ${tail}` : ''}`,
          ),
        );
      } else if (inputError !== undefined || !child.stdin?.writableFinished) {
        // close が書き込みの失敗より先に届く場合もあるので、書き切れたかどうかでも判定する。
        reject(
          new AgentCliError(
            'exit',
            `${agent} がプロンプトを読み終える前に終了しました${inputError === undefined ? '' : `: ${errorMessage(inputError)}`}`,
          ),
        );
      } else {
        done(Buffer.concat(stdout).toString('utf8'));
      }
    };
    child.once('error', (error) => {
      // 起動できなかった場合は close が届かないことがあるので、ここで終える。起動後の kill の失敗は close を待つ。
      if (child.pid === undefined) {
        finish(null, null, error);
      }
    });
    // EMFILE などで標準入出力を作れなかった場合は、ストリームを操作せずに起動の失敗として終える。
    const { stdin, stdout: output, stderr: errors } = child;
    if (!stdin || !output || !errors) {
      if (child.pid !== undefined) {
        child.kill('SIGKILL');
      }
      finish(null, null, new Error('標準入出力を作れませんでした'));
      return;
    }
    output.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (options.maxOutputBytes ?? AGENT_OUTPUT_MAX_BYTES)) {
        stop(new AgentCliError('outputLimit', `${agent} の出力が上限を超えました`));
      } else {
        stdout.push(chunk);
      }
    });
    errors.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_KEEP_BYTES);
    });
    // 標準入力を読み終える前に CLI が終了した場合は、差分を送れていないので失敗にする。
    stdin.on('error', (error) => {
      inputError ??= error;
    });
    child.once('close', (code, signal) => finish(code, signal));
    stdin.end(prompt);
  });
}
