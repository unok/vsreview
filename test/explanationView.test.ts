import fs, { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { Uri as VSCodeUri, WebviewView } from 'vscode';
import { expect, it, vi } from 'vitest';
import manifest from '../package.json';
import { comparisonKey } from '../src/core/comparisons';
import { revisionRef, type CommitTarget, type FileTarget } from '../src/core/documents';
import type { StoredExplanationFile } from '../src/core/explanations';
import { activate } from '../src/extension';
import * as agentCli from '../src/git/agentCli';
import { ExplanationStore } from '../src/git/explanationStore';
import { hashId, repositoryId } from '../src/git/repositoryId';
import { captureUncommittedChanges } from '../src/git/uncommitted';
import { ReviewDocuments } from '../src/ui/documents';
import { explanationPermissionKey } from '../src/ui/explanationPermissions';
import { PullRequestsTree } from '../src/ui/pullRequests';
import { RevisionArchives } from '../src/ui/revisionArchives';
import { revisionUri } from '../src/ui/revisions';
import * as fixtures from './fixtures';
import { commitAll } from './gitFixtures';
import * as mock from './vscodeMock';

const a = { path: 'a.ts', status: 'M' } as const;
const stable = { ...a, path: 'stable.ts' };
const GENERATING = '解説を生成中';
const GENERATION_FAILED = '最後の解説生成に失敗しました';
const NO_EXPLANATION = 'この比較の解説はまだありません';
const NOT_DIFF = '>差分ではないので解説なし';
const RESTART_NOTICE = '解説は再起動で消えます';
const file = (path: string) => mock.Uri.file(path) as VSCodeUri;
const diff = (target: FileTarget, right = revisionUri(target, 'new')) =>
  new mock.TabInputTextDiff(revisionUri(target, 'old'), right);
const generate = (node: unknown) => mock.commands.executeCommand('vsreview.generateExplanation', node);
const answer = (markdown: string) => JSON.stringify({ files: [{ id: 'F1', markdown }] });
const shown = (view: { webview: { html: string } }, message: string) =>
  fixtures.waitFor(() => expect(view.webview.html).toContain(message));

function openView() {
  const [, provider] = mock.window.registerWebviewViewProvider.mock.calls.find(
    ([id]) => id === 'vsreview.explanation',
  )!;
  const changed = new mock.EventEmitter<void>();
  const disposed = new mock.EventEmitter<void>();
  const writes = vi.fn<(value: string) => void>();
  const webview = {
    options: {},
    get html() {
      return writes.mock.lastCall?.[0] ?? '';
    },
    set html(value: string) {
      writes(value);
    },
  };
  const view = { visible: true, webview, onDidChangeVisibility: changed.event, onDidDispose: disposed.event };
  void provider.resolveWebviewView(view as unknown as WebviewView, { state: undefined }, mock.cancellationToken);
  return {
    view,
    writes,
    close: () => disposed.fire(),
    select(this: void, input: unknown, message: string) {
      mock.activateTab(input);
      return shown(view, message);
    },
    show(this: void, visible: boolean) {
      view.visible = visible;
      return changed.fireAsync();
    },
  };
}

async function fixture(persistent = true) {
  const { git, directory } = await fixtures.repository();
  await writeFile(join(directory, stable.path), '変更しない本文');
  for (const content of ['base', 'changed']) {
    await writeFile(join(directory, a.path), content);
    await commitAll(directory, content);
  }
  const commit = (await git.log(0, 1))[0]!;
  const target = { repo: git.root, commit, parent: commit.parents[0]!, file: a };
  const pr = { ...target, pullRequest: { number: 12, headRefOid: commit.hash, mergeBase: target.parent } };
  const storage = await fixtures.temporaryDirectory();
  const state = new fixtures.KeyedState();
  await state.update(explanationPermissionKey(git.root, 'claude'), true);
  const context = fixtures.extensionContext(state, persistent ? { storageUri: file(storage) } : {});
  mock.workspace.workspaceFolders = [fixtures.workspaceFolder(directory)];
  mock.globalConfiguration.set('vsreview.autoRefresh', false);
  const store = new ExplanationStore(storage);
  const generatedAt = new Date(2026, 10, 26, 10, 20, 30).toISOString();
  const metadata = { version: 1, agent: 'claude', generatedAt, promptVersion: 1 } as const;
  return {
    git,
    target,
    pr,
    context,
    storage,
    save(this: void, target: CommitTarget, ...files: StoredExplanationFile[]) {
      return store.write(target.repo, { ...metadata, comparison: comparisonKey(target), files });
    },
    async start(this: void) {
      const api = (await activate(context))!;
      expect(api.getExplanationView()).toBeUndefined();
      // 起動時の Git 処理と最初の描画が済んでからタブを操作する。
      await fixtures.waitFor(() => expect(api.commitsTree.git?.root).toBe(git.root));
      const opened = openView();
      await shown(opened.view, '差分を開くと表示します');
      return { api, ...opened };
    },
  };
}

it('タブなし・他の差分・別グループの通常編集タブを区別する', async () => {
  const { target, start } = await fixture();
  const { api, select } = await start();
  await select(new mock.TabInputTextDiff(file('/before'), file('/after')), 'VSReview の差分ではない');
  const working = file(join(target.repo, a.path));
  mock.window.tabGroups.all.push({ activeTab: undefined, tabs: [{ input: diff(target, working) }] });
  await select(new mock.TabInputText(working), NOT_DIFF);
  expect(api.getExplanationView()?.state).toBe('notDiff');
});

it('表示中のリポジトリをワークスペースから外すと、タブを切り替えなくても解説を消す', async () => {
  const { target, save, start } = await fixture();
  await save(target, { ...a, markdown: '表示中の解説' });
  const { api, view, select } = await start();
  await select(diff(target), '表示中の解説');
  await mock.tabsChanged.fireAsync(undefined);

  const removed = mock.workspace.workspaceFolders;
  mock.workspace.workspaceFolders = [];
  mock.foldersChanged.fire({ added: [], removed });
  await shown(view, 'VSReview の差分ではないので解説なし');
  expect(api.getExplanationView()?.state).toBe('notDiff');
  expect(view.webview.html).not.toContain('表示中の解説');
});

it('タブなしでアクティブなエディターの URI を使い、通常文書では解説を消す', async () => {
  const { target, save, start } = await fixture();
  await save(target, { ...a, markdown: 'エディターの解説' });
  const { api, view } = await start();
  const revision = await mock.window.showTextDocument(mock.textDocument(revisionUri(target, 'new'), ''));
  await mock.editorChanged.fireAsync(revision);
  await shown(view, 'エディターの解説');

  const working = await mock.window.showTextDocument(mock.textDocument(file(join(target.repo, a.path)), ''));
  await mock.editorChanged.fireAsync(working);
  await shown(view, NOT_DIFF);
  expect(api.getExplanationView()?.state).toBe('notDiff');
});

it('マニフェストのパネルに解説の Webview を登録し、起動イベントと ID が一致する', async () => {
  const { start } = await fixture();
  await start();
  const id = 'vsreview.explanation';
  expect(manifest.contributes.viewsContainers.panel).toContainEqual({
    id: 'vsreview-panel',
    title: 'VSReview',
    icon: 'assets/review.svg',
  });
  expect(manifest.contributes.views['vsreview-panel']).toContainEqual({ id, name: '解説', type: 'webview' });
  expect(manifest.activationEvents).toContain(`onView:${id}`);
  // VS Code はビューコンテナーの ID に英数字・「_」・「-」だけを受け付け、それ以外はビューを Explorer に回す。
  for (const container of Object.values(manifest.contributes.viewsContainers).flat()) {
    expect(container.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  }
  expect(mock.window.registerWebviewViewProvider).toHaveBeenCalledWith(id, expect.anything());
});

it('Webview タブでは、直前の解説を表示しない', async () => {
  const { target, save, start } = await fixture();
  await save(target, { ...a, markdown: '直前の解説' });
  const { view, select } = await start();
  const uri = revisionUri(target, 'new');
  await mock.window.showTextDocument(mock.textDocument(uri, ''));
  await select(new mock.TabInputText(uri), '直前の解説');
  await select(new mock.TabInputWebview('test.preview'), NOT_DIFF);
  expect(view.webview.html).not.toContain('直前の解説');
});

it('PR の初回生成中は案内を隠し、別の比較では生成中を表示しない', async () => {
  const { target, pr, start } = await fixture();
  vi.spyOn(PullRequestsTree.prototype, 'target').mockResolvedValue(pr);
  const response = fixtures.deferred<string>();
  const run = vi.spyOn(agentCli, 'runAgent').mockReturnValue(response.promise);
  const { view, select } = await start();
  await select(diff(pr), 'PR のノードを右クリック');
  const pending = generate({ kind: 'pullRequest', repo: pr.repo, pullRequest: fixtures.pullRequest });
  await shown(view, GENERATING);
  expect(view.webview.html).not.toContain(NO_EXPLANATION);
  await select(diff(target), 'コミットのノードを右クリック');
  expect(view.webview.html).not.toContain(GENERATING);
  await select(diff(pr), GENERATING);
  response.resolve(answer('## 検証方法'));
  await pending;
  await shown(view, '<h2>検証方法</h2>');

  await select(diff(target), 'コミットのノードを右クリック');
  run.mockRejectedValue(new Error('初回の生成エラー'));
  await generate({ kind: 'commit', ...target });
  await shown(view, '初回の生成エラー');
  expect(view.webview.html).toContain('「解説を生成」を選んでください');
});

it('再生成の失敗をエスケープし、再試行中は前回の失敗を隠して成功後に本文を更新する', async () => {
  const { target, pr, save, start } = await fixture();
  await save(pr, { ...a, markdown: '旧本文' });
  vi.spyOn(PullRequestsTree.prototype, 'target').mockResolvedValue(pr);
  mock.warning.mockResolvedValue('再生成');
  const failure = fixtures.deferred<string>();
  const run = vi.spyOn(agentCli, 'runAgent').mockReturnValue(failure.promise);
  const node = { kind: 'pullRequest', repo: pr.repo, pullRequest: fixtures.pullRequest };
  const { view, select } = await start();
  await select(diff(pr), '旧本文');
  const first = generate(node);
  await shown(view, GENERATING);
  expect(view.webview.html).toContain('旧本文');
  await fixtures.waitFor(() => expect(run).toHaveBeenCalled());
  failure.reject(new Error('<b>&"'));
  await first;
  await shown(view, '&lt;b&gt;&amp;&quot;');
  expect(view.webview.html).toContain(GENERATION_FAILED);
  expect(view.webview.html).toContain('旧本文');
  expect(view.webview.html).not.toContain('<b>');
  await select(diff(target), 'コミットのノードを右クリック');
  expect(view.webview.html).not.toContain(GENERATION_FAILED);
  await select(diff(pr), GENERATION_FAILED);

  const retry = fixtures.deferred<string>();
  run.mockReturnValue(retry.promise);
  const second = generate(node);
  await shown(view, GENERATING);
  expect(view.webview.html).toContain('旧本文');
  expect(view.webview.html).not.toContain(GENERATION_FAILED);
  retry.resolve(answer('新本文'));
  await second;
  await shown(view, '新本文');
  expect(view.webview.html).not.toContain('旧本文');
  expect(view.webview.html).not.toContain(GENERATION_FAILED);
});

it('索引を読み込めなくても、同じ比較の生成中表示を保つ', async () => {
  const { target, start } = await fixture();
  const response = fixtures.deferred<string>();
  vi.spyOn(agentCli, 'runAgent').mockReturnValue(response.promise);
  const { api, view, select, show } = await start();
  await select(diff(target), NO_EXPLANATION);
  const pending = generate({ kind: 'commit', ...target });
  await shown(view, GENERATING);
  const load = vi.spyOn(ExplanationStore.prototype, 'load').mockRejectedValue(new Error('索引を読めません'));
  await mock.commands.executeCommand('vsreview.refresh');
  await show(true);
  expect(api.getExplanationView()).toMatchObject({ state: 'failed', generating: true });
  expect(view.webview.html).toContain('解説の読み込みに失敗しました。 索引を読めません');
  expect(view.webview.html).toContain(GENERATING);
  load.mockRestore();
  response.resolve(answer('生成後の解説'));
  await pending;
  await shown(view, '生成後の解説');
});

it.each(['差分一覧', '文書の解決'])('%s が失敗したら解説ビューに表示し、再表示で復帰する', async (operation) => {
  const { target, save, start } = await fixture();
  await save(target, { ...a, markdown: '保存済みの解説' });
  const { api, view, select, show } = await start();
  await select(new mock.TabInputText(revisionUri(target, 'new')), '保存済みの解説');
  await show(false);
  const resolution =
    operation === '差分一覧'
      ? vi.spyOn(ReviewDocuments.prototype, 'openDiffs')
      : vi.spyOn(ReviewDocuments.prototype, 'resolve');
  resolution.mockRejectedValue(new Error(`${operation}を取得できません`));
  await show(true);
  expect(api.getExplanationView()?.state).toBe('failed');
  expect(view.webview.html).toContain(`解説の読み込みに失敗しました。 ${operation}を取得できません`);
  expect(view.webview.html).not.toContain('保存済みの解説');

  resolution.mockRestore();
  await show(true);
  expect(view.webview.html).toContain('保存済みの解説');
});

it('比較 A の索引を待つ同期が完了しても、切り替え先の比較 B を再描画しない', async () => {
  const older = await fixture();
  const newer = await fixture();
  await newer.save(older.target, { ...a, markdown: '比較 A の解説' });
  await newer.save(newer.target, { ...a, markdown: '比較 B の解説' });
  mock.workspace.workspaceFolders = [older, newer].map(({ git }, index) => fixtures.workspaceFolder(git.root, index));
  mock.pick.mockResolvedValue({ root: newer.git.root });
  const { api, view, writes, select, show } = await newer.start();
  await select(diff(newer.target), '比較 B の解説');

  const index = fixtures.deferred<void>();
  const originalLoad = Reflect.get<ExplanationStore, 'load'>(ExplanationStore.prototype, 'load');
  const load = vi.spyOn(ExplanationStore.prototype, 'load').mockImplementation(function (this: ExplanationStore, repo) {
    return index.promise.then(() => originalLoad.call(this, repo));
  });
  await show(false);
  mock.activateTab(diff(older.target));
  await mock.tabsChanged.fireAsync(undefined);
  const oldSynchronization = show(true);
  await shown(view, '解説を読み込み中');
  expect(api.getExplanationView()?.comparison).toBe(comparisonKey(older.target));
  await select(diff(newer.target), '比較 B の解説');
  const current = api.getExplanationView();
  const writeCount = writes.mock.calls.length;
  index.resolve();
  await oldSynchronization;
  load.mockRestore();
  expect(writes).toHaveBeenCalledTimes(writeCount);
  expect(api.getExplanationView()).toEqual(current);
  expect(view.webview.html).not.toContain('比較 A の解説');
  expect(view.webview.html).not.toContain('解説の読み込みに失敗しました');
  await select(diff(older.target), '比較 A の解説');
});

it('同じ比較でファイルを切り替えたら対応する本文とエスケープ済みのパスを表示する', async () => {
  const { target, save, start } = await fixture();
  const renamed = { path: 'new.ts', oldPath: 'old.ts', status: 'R' } as const;
  const deleted = { path: 'gone.ts', status: 'D' } as const;
  const escaped = { ...a, path: '<img onerror=x>&".ts' };
  await save(
    target,
    { ...renamed, markdown: 'リネーム本文' },
    { ...deleted, markdown: '削除本文' },
    {
      ...escaped,
      markdown: '特殊なパスの本文\n<script>x</script>',
    },
  );
  const { view, select } = await start();
  await select(diff({ ...target, file: renamed }), 'リネーム本文');
  await select(diff({ ...target, file: deleted }), '削除本文');
  expect(view.webview.html).not.toContain('リネーム本文');
  await select(diff({ ...target, file: escaped }), '特殊なパスの本文');
  expect(view.webview.html).not.toContain('削除本文');
  expect(view.webview.html).toContain('<h1>&lt;img onerror=x&gt;&amp;&quot;.ts · 変更</h1>');
  expect(view.webview.html).not.toMatch(/<(?:img|script)\b|\sonerror=["']/);
});

it('本文・メタデータと Webview の設定を表示し、非表示・破棄・再表示を扱う', async () => {
  const { target, pr, save, start } = await fixture();
  await save(target, { ...a, markdown: '## 検証方法' });
  const { api, view, writes, show, close, select } = await start();
  await select(diff(target), '<h2>検証方法</h2>');
  expect(api.getExplanationView()?.html).toBe(view.webview.html);
  expect(view.webview.html).toContain('2026-11-26 10:20:30 · claude');
  expect(view.webview.html).toContain('a.ts · 変更');
  expect(view.webview.html).not.toContain(RESTART_NOTICE);
  expect(view.webview.options).toEqual({ enableScripts: false, enableCommandUris: false, localResourceRoots: [] });
  const nonce = /<style nonce="([^"]+)">/.exec(view.webview.html)![1];
  expect(view.webview.html).toContain(
    `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'none'; font-src 'none'; form-action 'none'`,
  );
  const count = writes.mock.calls.length;
  await show(true);
  expect(writes).toHaveBeenCalledTimes(count);
  await show(false);
  mock.activateTab(diff(pr));
  await mock.tabsChanged.fireAsync(undefined);
  expect(api.getExplanationView()).toMatchObject({ visible: false, comparison: comparisonKey(target), path: a.path });
  expect(writes).toHaveBeenCalledTimes(count);
  await show(true);
  expect(view.webview.html).toContain('PR のノードを右クリック');
  close();
  expect(api.getExplanationView()).toBeUndefined();
  await shown(openView().view, 'PR のノードを右クリック');
});

it('未コミットの記録の省略理由を表示する', async () => {
  const { git, save, start } = await fixture();
  await writeFile(join(git.root, a.path), 'working\n');
  const { staged, unstaged, head, createdAt } = await captureUncommittedChanges(git);
  const { select } = await start();
  for (const [skipped, label] of [
    ['binary', 'バイナリのため解説なし'],
    ['tooLarge', '大きすぎるため省略'],
    ['submodule', 'サブモジュールのため解説なし'],
    ['missing', '出力に含まれないため解説なし'],
    ['invalid', '出力が不正のため解説なし'],
  ] as const) {
    const change = skipped === 'binary' ? staged : unstaged;
    const target = { ...change, repo: git.root, file: a, uncommitted: { kind: change.kind, head: head!, createdAt } };
    await save(target, { ...a, skipped });
    await mock.commands.executeCommand('vsreview.refresh');
    await select(diff(target), label);
  }
});

it('展開先の未変更ファイルと単独の仮想文書も保存された比較で表示する', async () => {
  const { git, target, save, context, start } = await fixture();
  const access = await fixtures.accessFor(target.repo);
  const archives = RevisionArchives.create(context, access, fixtures.revisionSnapshots(access));
  mock.warning.mockResolvedValue('許可');
  const expanded = (await archives.uri(revisionRef({ ...target, file: stable }, 'new')))!;
  await expect(fs.readFile(expanded.fsPath, 'utf8')).resolves.toBe('変更しない本文');
  expect(await git.files(target.commit)).toEqual([a]);
  await save(target, { ...a, markdown: '別ファイルの解説' });
  const { select } = await start();
  await select(new mock.TabInputText(expanded), 'この比較の記録にないファイルです');
  await select(new mock.TabInputText(revisionUri(target, 'new')), '別ファイルの解説');
});

it.each(['破損', 'EACCES'])('%s の保存ファイルを区別する', async (failure) => {
  const { target, storage, save, start } = await fixture();
  await save(target, { ...a, markdown: '保存内容' });
  const name = `${hashId(comparisonKey(target))}.json`;
  const savedPath = join(storage, 'explanations', repositoryId(target.repo), name);
  if (failure === '破損') {
    await writeFile(savedPath, '{');
  } else {
    const denied = Object.assign(new Error('アクセスが拒否されました'), { code: 'EACCES' });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((path, options) =>
      path === savedPath ? Promise.reject(denied) : readFile(path, options),
    );
    syncBuiltinESMExports();
  }
  const { select } = await start();
  const message =
    failure === '破損' ? '保存した解説を読み込めません' : '解説の読み込みに失敗しました。 アクセスが拒否されました';
  await select(diff(target), message);
});

it('メモリだけに保存した未ステージの解説には再起動の注意を添える', async () => {
  const { git, start } = await fixture(false);
  await writeFile(join(git.root, a.path), 'working\n');
  const { unstaged, head, createdAt } = await captureUncommittedChanges(git);
  vi.spyOn(agentCli, 'runAgent').mockResolvedValue(answer('メモリの解説'));
  const { view, select } = await start();
  expect(view.webview.html).not.toContain(RESTART_NOTICE);
  const uncommitted = { kind: 'unstaged', head: head!, createdAt } as const;
  await select(diff({ ...unstaged, repo: git.root, file: a, uncommitted }), NO_EXPLANATION);
  expect(view.webview.html).not.toContain(RESTART_NOTICE);
  await generate({ kind: 'uncommittedGroup', repo: git.root, change: { kind: 'unstaged' } });
  await shown(view, 'メモリの解説');
  expect(view.webview.html).toContain(RESTART_NOTICE);
});
