import { gitExecutable } from '../src/git/executable.mts';
import { commitAll } from '../fixtures/gitFixtures.mts';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, open, chmod, cp, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bundleOptions } from '../esbuild.options.mjs';

const XVFB_SCREEN = '1280x900x24';
const XVFB_STARTUP_POLL_MS = 50;
const XVFB_STARTUP_TIMEOUT_MS = 5000;
const project = process.cwd();
await mkdir('.scratch', { recursive: true });
const scratch = await mkdtemp(resolve('.scratch/e2e-'));
const repo = join(scratch, 'repo 日本');
await mkdir(repo);
const git = (...args) => execFileSync(gitExecutable(), ['-C', repo, ...args], { encoding: 'utf8' });
git('init', '-b', 'main');
await writeFile(
  join(repo, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }),
);
await writeFile(join(repo, 'lib.ts'), 'export function greet(name: string): string { return name; }\n');
await writeFile(join(repo, 'main.ts'), "import { greet } from './lib';\nconsole.log(greet('before'));\n");
await writeFile(join(repo, 'deleted.ts'), "import { greet } from './lib';\nconsole.log(greet('deleted'));\n");
await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
await mkdir(join(repo, 'packages/crawler/src'), { recursive: true });
await writeFile(
  join(repo, 'packages/crawler/tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, module: 'commonjs' }, include: ['src/*.ts'] }),
);
const dependencySource = "import { dependency } from 'nm-dependency';\nconsole.log(dependency('before'));\n";
await writeFile(join(repo, 'packages/crawler/src/main.ts'), dependencySource);
await writeFile(join(repo, 'packages/crawler/src/deleted.ts'), dependencySource);
await commitAll(repo, 'initial');
await rm(join(repo, 'deleted.ts'));
await rm(join(repo, 'packages/crawler/src/deleted.ts'));
await writeFile(join(repo, 'packages/crawler/src/main.ts'), dependencySource.replace('before', 'review'));
await writeFile(join(repo, 'main.ts'), "import { greet } from './lib';\nconsole.log(greet('review'));\n");
await mkdir(join(repo, 'src/ui'), { recursive: true });
await writeFile(join(repo, 'src/ui/nested.ts'), 'export const nested = true;\n');
await commitAll(repo, 'review target');
const origin = join(scratch, 'origin.git');
execFileSync(gitExecutable(), ['init', '--bare', origin]);
git('remote', 'add', 'origin', origin);
git('push', 'origin', 'main', 'HEAD:refs/pull/12/head');
const fakeBin = join(scratch, 'bin');
await mkdir(fakeBin);
const fakeGh = join(fakeBin, 'gh');
const pullRequest = {
  number: 12,
  title: 'E2E PR review',
  author: { login: 'reviewer' },
  baseRefName: 'main',
  headRefName: 'topic',
  baseRefOid: git('rev-parse', 'HEAD^').trim(),
  headRefOid: git('rev-parse', 'HEAD').trim(),
  url: 'https://github.com/example/repo/pull/12',
  isCrossRepository: true,
  state: 'OPEN',
  headRepository: { name: 'repo' },
  headRepositoryOwner: { login: 'contributor' },
  updatedAt: '2026-11-09T00:00:00Z',
};
await writeFile(
  fakeGh,
  `#!/usr/bin/env node
const pr = ${JSON.stringify(pullRequest)};
process.stdout.write(JSON.stringify(process.argv[3] === 'list' ? [pr] : pr));
`,
);
await chmod(fakeGh, 0o755);
const worktree = join(scratch, 'agent worktree 日本');
git('worktree', 'add', '-b', 'review-agent', worktree, 'HEAD');
// インストールやネットワークを使わず、pnpm のパッケージ別リンクを再現する。
const dependency = join(worktree, 'node_modules/.pnpm/nm-dependency/node_modules/nm-dependency');
await mkdir(dependency, { recursive: true });
await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'nm-dependency', types: 'index.d.ts' }));
await writeFile(join(dependency, 'index.d.ts'), 'export declare function dependency(value: string): string;\n');
await mkdir(join(worktree, 'packages/crawler/node_modules'));
await symlink(
  '../../../node_modules/.pnpm/nm-dependency/node_modules/nm-dependency',
  join(worktree, 'packages/crawler/node_modules/nm-dependency'),
  'dir',
);
await build({ ...bundleOptions, entryPoints: ['e2e/index.ts'], outfile: 'dist/e2e/index.js' });
const testExtension = join(scratch, 'extension');
await mkdir(testExtension);
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
await writeFile(join(testExtension, 'package.json'), JSON.stringify({ ...manifest, main: './extension.js' }));
await cp(join(project, 'assets'), join(testExtension, 'assets'), { recursive: true });
await build({ ...bundleOptions, entryPoints: ['e2e/extension.ts'], outfile: join(testExtension, 'extension.js') });
const displayFile = join(scratch, 'display');
const displayHandle = await open(displayFile, 'w+');
const xvfb = spawn(
  process.env.VSREVIEW_XVFB ?? 'Xvfb',
  ['-displayfd', '3', '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp'],
  {
    stdio: ['ignore', 'inherit', 'inherit', displayHandle.fd],
  },
);
let spawnError;
const exited = new Promise((done) => {
  xvfb.once('error', (error) => {
    spawnError = error;
    done();
  });
  xvfb.once('exit', () => done());
});
const hasExited = () => xvfb.exitCode !== null || xvfb.signalCode !== null;
try {
  let display;
  for (let attempt = 0; attempt < XVFB_STARTUP_TIMEOUT_MS / XVFB_STARTUP_POLL_MS; attempt++) {
    if (spawnError) {
      throw spawnError;
    }
    if (hasExited()) {
      throw new Error(`Xvfb が終了しました: ${xvfb.exitCode ?? xvfb.signalCode}`);
    }
    display = (await readFile(displayFile, 'utf8')).trim();
    if (display) {
      break;
    }
    await new Promise((done) => setTimeout(done, XVFB_STARTUP_POLL_MS));
  }
  if (!display) {
    throw new Error('Xvfb がディスプレイ番号を返しませんでした');
  }
  const code = process.env.VSREVIEW_CODE ?? execFileSync('which', ['code'], { encoding: 'utf8' }).trim();
  const userData = join(scratch, 'user');
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    DISPLAY: `:${display}`,
    VSREVIEW_E2E_PULL_REQUEST: JSON.stringify(pullRequest),
    VSREVIEW_E2E_USER_DATA: userData,
    VSREVIEW_E2E_RESULT: join(scratch, 'result.json'),
    ELECTRON_RUN_AS_NODE: undefined,
    VSCODE_IPC_HOOK_CLI: undefined,
  };
  await runTests({
    vscodeExecutablePath: code,
    reuseMachineInstall: true,
    extensionDevelopmentPath: testExtension,
    extensionTestsPath: join(project, 'dist/e2e/index.js'),
    extensionTestsEnv: environment,
    launchArgs: [
      worktree,
      '--wait',
      // 既存のコメント入力欄を CDP でクリックするため、デバッグ接続を有効にする。
      '--remote-debugging-port=0',
      '--user-data-dir',
      userData,
      '--extensions-dir',
      join(scratch, 'extensions'),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
    ],
  });
  const result = JSON.parse(await readFile(environment.VSREVIEW_E2E_RESULT, 'utf8'));
  if (result.status !== 'passed') {
    throw new Error('拡張ホストが E2E 完了を記録しませんでした');
  }
  process.stdout.write(
    'E2E passed: worktree amend auto-refresh / commits / working-tree diff / revision archives / deleted-file TypeScript definition / comments / PR tree / PR question export / Markdown / clipboard\n',
  );
} finally {
  if (xvfb.pid && !hasExited() && !spawnError) {
    xvfb.kill('SIGTERM');
    await exited;
  }
  await displayHandle.close();
  // 失敗時の VS Code ログは調査できるよう scratch に残す。
  await rm(displayFile, { force: true });
  process.stdout.write(`E2E artifacts: ${scratch}\n`);
}
