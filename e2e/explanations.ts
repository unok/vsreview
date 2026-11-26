import * as assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewApi } from '../src/extension';
import { resolveExecutable } from '../src/git/executable.mts';
import type { CommitNode } from '../src/ui/trees';
import { poll } from './timeouts';

const explainedLabel = /(?:^| · )解説あり(?: · |$)/u;

export async function checkExplanations(
  api: ReviewApi,
  commit: Extract<CommitNode, { kind: 'commit' }>,
  main: Extract<CommitNode, { kind: 'file' }>,
  nested: Extract<CommitNode, { kind: 'file' }>,
): Promise<void> {
  const executable = process.env.VSREVIEW_E2E_CLAUDE;
  const log = process.env.VSREVIEW_E2E_CLAUDE_LOG;
  assert.ok(executable && log, 'テスト用 claude が設定されていません');
  assert.equal(await realpath(resolveExecutable('claude')), await realpath(executable));

  await vscode.commands.executeCommand('vsreview.generateExplanation', commit);
  const invocation = JSON.parse(await readFile(log, 'utf8')) as {
    args: string[];
    cwd: string;
    entries: string[];
    prompt: string;
    fileCount: number;
  };
  assert.deepEqual(invocation.args, [
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
  assert.ok(invocation.fileCount > 0, 'テスト用 claude がプロンプトからファイルの ID とパスを読み取れませんでした');
  assert.match(invocation.prompt, /^\+console\.log\(greet\('review'\)\);$/mu, 'main.ts の追加行が送信されていません');
  const fromRepo = relative(await realpath(commit.repo), invocation.cwd);
  assert.ok(fromRepo === '..' || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo), invocation.cwd);
  assert.deepEqual(invocation.entries, []);
  await poll(() => {
    const description = api.commitsTree.getTreeItem(main).description;
    return Promise.resolve(typeof description === 'string' && explainedLabel.test(description) ? true : undefined);
  }, 'main.ts のツリーに「解説あり」と表示されませんでした');

  await vscode.commands.executeCommand('vsreview.openDiff', main);
  await vscode.commands.executeCommand('vsreview.explanation.focus');
  const explained = await poll(() => {
    const view = api.getExplanationView();
    return Promise.resolve(
      view?.visible && view.path === main.file.path && view.state === 'explained' ? view : undefined,
    );
  }, '解説ビューに main.ts の解説が表示されませんでした');
  assert.match(explained.html, /<h2>テスト用の解説<\/h2>/u);
  assert.match(explained.html, /<p>main\.ts の差分を読みました。<\/p>/u);

  await vscode.commands.executeCommand('workbench.action.closePanel');
  await poll(
    () => Promise.resolve(api.getExplanationView()?.visible === false ? true : undefined),
    '下部パネルを閉じても解説ビューが表示されています',
  );
  await vscode.commands.executeCommand('vsreview.explanation.focus');
  await vscode.commands.executeCommand('vsreview.openDiff', nested);
  const skipped = await poll(() => {
    const view = api.getExplanationView();
    return Promise.resolve(
      view?.visible && view.path === nested.file.path && view.state === 'skipped' ? view : undefined,
    );
  }, '空白の出力を返したファイルに解説なしの理由が表示されませんでした');
  assert.equal(skipped.comparison, explained.comparison);
  assert.match(skipped.html, /出力が不正のため解説なし/u);
  assert.doesNotMatch(String(api.commitsTree.getTreeItem(nested).description ?? ''), explainedLabel);
}

export async function checkExplanationFailure(
  api: ReviewApi,
  commit: Extract<CommitNode, { kind: 'commit' }>,
  main: Extract<CommitNode, { kind: 'file' }>,
): Promise<void> {
  await vscode.commands.executeCommand('vsreview.openDiff', main);
  await vscode.commands.executeCommand('vsreview.explanation.focus');
  // 拡張ホストと同じプロセスで実行され、runAgent が process.env を子プロセスに渡す。
  process.env.VSREVIEW_E2E_CLAUDE_FAILURE = '1';
  try {
    await vscode.commands.executeCommand('vsreview.generateExplanation', commit);
  } finally {
    delete process.env.VSREVIEW_E2E_CLAUDE_FAILURE;
  }
  const failed = await poll(() => {
    const view = api.getExplanationView();
    return Promise.resolve(view?.visible && view.path === main.file.path && view.failure ? view : undefined);
  }, '生成の失敗が解説ビューに表示されませんでした');
  assert.equal(failed.state, 'none');
  assert.match(failed.html, /最後の解説生成に失敗しました。 claude が終了コード 7 で失敗しました: テスト用の失敗/u);
}
