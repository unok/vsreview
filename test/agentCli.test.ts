import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_ARGUMENTS, AGENT_KILL_GRACE_MS, AGENT_TIMEOUT_MS, AgentCliError, runAgent } from '../src/git/agentCli';
import { temporaryDirectory } from './fixtures';

// 実物の claude は呼ばず、PATH に置いた偽の実行ファイルで確かめる。
async function fakeClaude(script: string): Promise<string> {
  const bin = await temporaryDirectory();
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
  const record = join(await temporaryDirectory(), 'record.json');
  vi.stubEnv('VSREVIEW_TEST_RECORD', record);
  return record;
}
// 偽の実行ファイルが起動時の状態を記録する。
const RECORD = `const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
const record = () => fs.writeFileSync(process.env.VSREVIEW_TEST_RECORD, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), input, pid: process.pid,
  locale: process.env.LC_ALL ?? null, home: process.env.HOME ?? null,
}));
`;
async function recorded(record: string): Promise<{
  args: string[];
  cwd: string;
  entries: string[];
  input: string;
  pid: number;
  locale: string | null;
  home: string | null;
}> {
  return JSON.parse(await readFile(record, 'utf8')) as Awaited<ReturnType<typeof recorded>>;
}
async function removed(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
}
// パイプの容量を超え、CLI の終了後も書き込みが残る大きさ。
const LARGE_PROMPT_BYTES = 8 * 1024 * 1024;
// 偽のタイマーの下でも待てるよう、node:timers/promises で記録ファイルの出現を待つ。
async function appeared(path: string): Promise<void> {
  while (await removed(path)) {
    await sleep(10);
  }
}
async function agentDirectories(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('vsreview-agent-')).sort();
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function failure(promise: Promise<unknown>): Promise<AgentCliError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AgentCliError);
  return error as AgentCliError;
}

describe('runAgent', () => {
  it('引数・標準入力を渡し、空の一時ディレクトリで起動して標準出力を返し、終了後に消す', async () => {
    const record = await fakeClaude(
      `${RECORD}process.stdin.on('end', () => { record(); process.stdout.write('{"files":[]} 解説'); });`,
    );
    vi.stubEnv('LC_ALL', 'ja_JP.UTF-8');
    const prompt = '# 差分の解説\n\n```diff\n+日本語の行 🎌\n```\n';
    expect(await runAgent('claude', prompt)).toBe('{"files":[]} 解説');
    const state = await recorded(record);
    expect(state.args).toEqual([
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
    ]);
    expect(AGENT_ARGUMENTS.claude).toEqual(state.args);
    expect(state.input).toBe(prompt);
    expect(state.entries).toEqual([]);
    expect(state.cwd).not.toBe(process.cwd());
    expect(state.cwd).toContain('vsreview-agent-');
    // Git 用の LC_ALL=C を強制せず、親の環境を引き継ぐ。
    expect(state.locale).toBe('ja_JP.UTF-8');
    expect(state.home).toBe(process.env.HOME ?? null);
    expect(await removed(state.cwd)).toBe(true);
  });

  it('空のプロンプトと空の出力もそのまま扱う', async () => {
    const record = await fakeClaude(`${RECORD}process.stdin.on('end', record);`);
    expect(await runAgent('claude', '')).toBe('');
    expect((await recorded(record)).input).toBe('');
  });

  it('非ゼロ終了では標準エラーの末尾を、制御文字を無害化して含める', async () => {
    const record = await fakeClaude(
      `${RECORD}record(); process.stderr.write('x'.repeat(5000) + '\\nNot logged in\\u001b[31m'); process.exit(3);`,
    );
    const error = await failure(runAgent('claude', 'prompt'));
    expect(error.failure).toBe('exit');
    expect(error.message).toMatch(/^claude が終了コード 3 で失敗しました: x+ Not logged in \[31m$/);
    expect(error.message.length).toBeLessThan(1100);
    expect(await removed((await recorded(record)).cwd)).toBe(true);
  });

  it('標準エラーが空の非ゼロ終了は終了コードだけを示す', async () => {
    await fakeClaude('process.exit(1);');
    expect((await failure(runAgent('claude', 'prompt'))).message).toBe('claude が終了コード 1 で失敗しました');
  });

  it('時間内に終わらなければ子プロセスを終了させ、終了を待ってから一時ディレクトリを消して失敗を返す', async () => {
    const record = await fakeClaude(`${RECORD}record(); setInterval(() => {}, 1000);`);
    expect(AGENT_TIMEOUT_MS).toBe(600_000);
    // 起動と記録を待ってから時間切れにするため、runAgent のタイマーだけを偽にする。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = failure(runAgent('claude', 'prompt'));
    await appeared(record);
    vi.advanceTimersByTime(AGENT_TIMEOUT_MS);
    vi.useRealTimers();
    const error = await pending;
    expect(error.failure).toBe('timeout');
    const state = await recorded(record);
    expect(running(state.pid)).toBe(false);
    expect(await removed(state.cwd)).toBe(true);
  });

  it('時間切れの後に CLI が終了コード 0 で終わっても、出力を採用しない', async () => {
    const record = await fakeClaude(
      `${RECORD}process.on('SIGTERM', () => { process.stdout.write('late'); process.exit(0); }); record(); setInterval(() => {}, 1000);`,
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = failure(runAgent('claude', 'prompt'));
    await appeared(record);
    vi.advanceTimersByTime(AGENT_TIMEOUT_MS);
    vi.useRealTimers();
    expect((await pending).failure).toBe('timeout');
  });

  it('出力が上限を超えたら失敗にする。ちょうど上限は受け取る', async () => {
    await fakeClaude(`process.stdout.write('あ'.repeat(10));`);
    expect(await runAgent('claude', 'prompt', { maxOutputBytes: 30 })).toBe('あ'.repeat(10));
    expect((await failure(runAgent('claude', 'prompt', { maxOutputBytes: 29 }))).failure).toBe('outputLimit');
  });

  it('中断すると子プロセスの終了を待ってから、一時ディレクトリを消して失敗を返す', async () => {
    const record = await fakeClaude(`${RECORD}record(); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = failure(runAgent('claude', 'prompt', { signal: controller.signal }));
    await appeared(record);
    controller.abort();
    const error = await pending;
    expect(error.failure).toBe('aborted');
    const state = await recorded(record);
    expect(running(state.pid)).toBe(false);
    expect(await removed(state.cwd)).toBe(true);
  });

  it('SIGTERM を無視する CLI は猶予の後に強制終了する', async () => {
    const record = await fakeClaude(`${RECORD}process.on('SIGTERM', () => {}); record(); setInterval(() => {}, 1000);`);
    expect(AGENT_KILL_GRACE_MS).toBe(5000);
    const controller = new AbortController();
    const pending = failure(runAgent('claude', 'prompt', { signal: controller.signal, killGrace: 200 }));
    await appeared(record);
    controller.abort();
    expect((await pending).failure).toBe('aborted');
    const state = await recorded(record);
    expect(running(state.pid)).toBe(false);
    expect(await removed(state.cwd)).toBe(true);
  });

  it('標準入力を読まずに終了コード 0 で終わる CLI は、プロンプトを送れなかった失敗にする', async () => {
    await fakeClaude(`process.stdout.write('{"files":[]}'); process.exit(0);`);
    // 書き込みの失敗と終了のどちらが先に届いても失敗になることを、繰り返して確かめる。
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = await failure(runAgent('claude', 'x'.repeat(LARGE_PROMPT_BYTES)));
      expect(error.failure).toBe('exit');
      expect(error.message).toContain('claude がプロンプトを読み終える前に終了しました');
    }
  });

  it('書き込みの失敗より先に終了が届いても、プロンプトを書き切れていなければ失敗にする', async () => {
    await fakeClaude('');
    // 終了の通知が書き込みの失敗より先に届く順序を、決まった形で作る。
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      stdin: new Writable({ write: () => {} }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      setImmediate(() => child.emit('close', 0, null));
      return child as unknown as ChildProcess;
    });
    syncBuiltinESMExports();
    const error = await failure(runAgent('claude', 'prompt'));
    expect(error.failure).toBe('exit');
    expect(error.message).toBe('claude がプロンプトを読み終える前に終了しました');
  });

  it.each(['timeout', 'aborted'] as const)(
    '出力を継承した子孫が残っても、%s で停止した後は有限時間で失敗を返し一時ディレクトリを消す',
    async (failureKind) => {
      const record = await fakeClaude(
        `${RECORD}const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(process.env.VSREVIEW_TEST_RECORD + '.descendant', String(descendant.pid));
record(); setInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();
      if (failureKind === 'timeout') {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      }
      const pending = failure(runAgent('claude', 'prompt', { signal: controller.signal }));
      await appeared(record);
      const descendant = Number(await readFile(`${record}.descendant`, 'utf8'));
      try {
        if (failureKind === 'timeout') {
          vi.advanceTimersByTime(AGENT_TIMEOUT_MS);
          vi.useRealTimers();
        } else {
          controller.abort();
        }
        const error = await pending;
        expect(error.failure).toBe(failureKind);
        const state = await recorded(record);
        expect(running(state.pid)).toBe(false);
        expect(await removed(state.cwd)).toBe(true);
        expect(running(descendant)).toBe(true);
      } finally {
        process.kill(descendant, 'SIGKILL');
      }
    },
  );

  it('出力を継承した子孫が残っても、非ゼロ終了は時間切れを待たずに終了コードと標準エラーを返す', async () => {
    const record = await fakeClaude(
      `${RECORD}const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.writeFileSync(process.env.VSREVIEW_TEST_RECORD + '.descendant', String(descendant.pid));
record(); process.stderr.write('Not logged in'); process.exitCode = 3; descendant.unref();`,
    );
    const pending = failure(runAgent('claude', 'prompt'));
    await appeared(`${record}.descendant`);
    const descendant = Number(await readFile(`${record}.descendant`, 'utf8'));
    try {
      const error = await pending;
      expect(error.failure).toBe('exit');
      expect(error.message).toBe('claude が終了コード 3 で失敗しました: Not logged in');
      expect(await removed((await recorded(record)).cwd)).toBe(true);
    } finally {
      process.kill(descendant, 'SIGKILL');
    }
  });

  it('上限を超えた後も出力を続ける CLI を停止させ、一時ディレクトリを消す', async () => {
    const record = await fakeClaude(`${RECORD}record(); setInterval(() => process.stdout.write('x'.repeat(1000)), 1);`);
    const error = await failure(runAgent('claude', 'prompt', { maxOutputBytes: 10_000 }));
    expect(error.failure).toBe('outputLimit');
    const state = await recorded(record);
    expect(running(state.pid)).toBe(false);
    expect(await removed(state.cwd)).toBe(true);
  });

  it('一時ディレクトリを作る間に中断されたら起動せず、一時ディレクトリを残さない', async () => {
    const record = await fakeClaude(`${RECORD}record();`);
    const before = await agentDirectories();
    const controller = new AbortController();
    const pending = failure(runAgent('claude', 'prompt', { signal: controller.signal }));
    controller.abort();
    expect((await pending).failure).toBe('aborted');
    expect(await removed(record)).toBe(true);
    expect(await agentDirectories()).toEqual(before);
  });

  it('標準入出力を作れない子プロセスは起動失敗として返し、タイマーとリスナーを残さない', async () => {
    await fakeClaude('');
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    vi.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ChildProcess);
    syncBuiltinESMExports();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const error = await failure(runAgent('claude', 'prompt', { signal: controller.signal }));
    expect(error.failure).toBe('spawn');
    expect(error.message).toBe('claude を起動できませんでした: 標準入出力を作れませんでした');
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('シグナルで自ら終了した CLI は、シグナル名を示す', async () => {
    await fakeClaude(`process.kill(process.pid, 'SIGKILL');`);
    const error = await failure(runAgent('claude', 'prompt'));
    expect(error.failure).toBe('exit');
    expect(error.message).toBe('claude がシグナル SIGKILL で失敗しました');
  });

  it('中断済みのシグナルでは、CLI の探索より前に中断として返し、起動しない', async () => {
    const record = await fakeClaude(`${RECORD}record();`);
    const controller = new AbortController();
    controller.abort();
    const before = await agentDirectories();
    expect((await failure(runAgent('claude', 'prompt', { signal: controller.signal }))).failure).toBe('aborted');
    vi.stubEnv('PATH', '');
    expect((await failure(runAgent('claude', 'prompt', { signal: controller.signal }))).failure).toBe('aborted');
    expect(await removed(record)).toBe(true);
    expect(await agentDirectories()).toEqual(before);
  });

  it('PATH にないときは、どの CLI が見つからないかを示し、一時ディレクトリを作らない', async () => {
    vi.stubEnv('PATH', await temporaryDirectory());
    const before = await agentDirectories();
    const error = await failure(runAgent('claude', 'prompt'));
    expect(error.failure).toBe('spawn');
    expect(error.message).toBe('PATH に claude 実行ファイルが見つかりません');
    expect(await agentDirectories()).toEqual(before);
  });

  it('一時ディレクトリを作れないときは起動失敗として返す', async () => {
    const record = await fakeClaude(`${RECORD}record();`);
    vi.stubEnv('TMPDIR', join(await temporaryDirectory(), 'missing'));
    const error = await failure(runAgent('claude', 'prompt'));
    expect(error.failure).toBe('spawn');
    expect(error.message).toContain('ENOENT');
    expect(await removed(record)).toBe(true);
  });

  it('起動できない実行ファイルは起動失敗として区別する', async () => {
    const bin = await temporaryDirectory();
    await writeFile(join(bin, 'claude'), '#!/nonexistent/interpreter\n', { mode: 0o755 });
    vi.stubEnv('PATH', bin);
    expect((await failure(runAgent('claude', 'prompt'))).failure).toBe('spawn');
  });
});
