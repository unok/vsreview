import { exportMarkdown } from '../src/core/export';
import { commentPurposeLabel } from '../src/core/presentation';
import { runGit } from '../src/git/client';
import { poll, waitForActiveEditor } from './timeouts';
import { clickCommentInput, clickCommentSaveButton, createCommentInput } from './commentInput';
import { selectQuickPick } from './quickPick';
import { clickWorkbenchElement, visibleElementExpression } from './workbench';
import { commitAll } from '../fixtures/gitFixtures.mts';
import { realpath, writeFile } from 'node:fs/promises';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { basename, dirname, join } from 'node:path';
import { statusUri } from '../src/ui/decorations';
import { parseStatusUri } from '../src/core/decorations';
import type { ReviewApi } from '../src/extension';
import { checkExplanationFailure, checkExplanations } from './explanations';

async function definition(
  uri: vscode.Uri,
  symbol = 'greet',
  file = 'lib.ts',
): Promise<vscode.Location | vscode.LocationLink> {
  const source = await vscode.workspace.openTextDocument(uri);
  const invocation = source.getText().indexOf(symbol);
  assert.ok(invocation >= 0, `fixture に ${symbol} がありません`);
  const position = source.positionAt(invocation);
  return poll(async () => {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    return result?.find(
      (location) => basename(('uri' in location ? location.uri : location.targetUri).fsPath) === file,
    );
  }, `TypeScript の定義プロバイダが ${file} を返しませんでした`);
}
export async function run(): Promise<void> {
  const resultFile = process.env.VSREVIEW_E2E_RESULT;
  assert.ok(resultFile);
  await writeFile(resultFile, JSON.stringify({ status: 'started' }));
  const extension = vscode.extensions.getExtension<ReviewApi>('vsreview.vsreview');
  assert.ok(extension, '拡張がインストールされていません');
  const api = await extension.activate();
  assert.ok(api);
  const commits = await poll(async () => {
    const nodes = await api.commitsTree.getChildren();
    return nodes.some((node) => node.kind === 'commit' && node.commit.subject === 'review target') ? nodes : undefined;
  }, 'コミット一覧の初期読み込みが完了しませんでした');
  const latest = commits.find((node) => node.kind === 'commit' && node.commit.subject === 'review target');
  assert.ok(latest && latest.kind === 'commit');
  await vscode.commands.executeCommand('vsreview.showFileTree');
  const latestFiles = await api.commitsTree.getChildren(latest);
  const folder = latestFiles.find((node) => node.kind === 'folder' && node.folder.path === 'src/ui');
  assert.ok(folder, 'ツリー表示にフォルダノードがありません');
  assert.equal(api.commitsTree.getTreeItem(folder).label, 'src/ui');
  assert.equal(api.commitsTree.getTreeItem(folder).description, '');
  const nested = await api.commitsTree.getChildren(folder);
  assert.ok(
    nested.some((node) => node.kind === 'file' && node.file.path === 'src/ui/nested.ts'),
    'フォルダの下に変更ファイルがありません',
  );
  await vscode.commands.executeCommand('vsreview.showFileList');
  const latestList = await api.commitsTree.getChildren(latest);
  assert.ok(latestList.every((node) => node.kind === 'file'));
  assert.ok(latestList.some((node) => node.kind === 'file' && node.file.path === 'src/ui/nested.ts'));
  // 拡張が登録した Provider の読み取り API で、実ノードの URI を検証する。
  for (const node of [...nested, ...latestList]) {
    if (node.kind !== 'file') {
      continue;
    }
    const item = api.commitsTree.getTreeItem(node);
    assert.ok(item.resourceUri);
    const uri = vscode.Uri.parse(item.resourceUri.toString());
    assert.equal(uri.scheme, 'vsreview-status');
    assert.equal(uri.path, `/${node.file.path}`);
    assert.equal(parseStatusUri(uri)?.commit, node.commit.hash);
    assert.deepEqual(item.iconPath, vscode.ThemeIcon.File);
    assert.equal(item.label, node.name);
    assert.equal(item.description, node.file.oldPath ?? '');
    const decoration = api.provideFileDecoration(uri);
    assert.equal(decoration?.badge, node.file.status);
    assert.ok(decoration?.color instanceof vscode.ThemeColor);
  }
  const folderItem = api.commitsTree.getTreeItem(folder);
  assert.ok(folderItem.resourceUri);
  const folderDecoration = api.provideFileDecoration(folderItem.resourceUri);
  assert.deepEqual(folderDecoration?.color, new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
  assert.equal(folderDecoration?.badge, undefined);
  const special = statusUri({
    repo: latest.repo,
    commit: latest.commit.hash,
    side: 'old',
    kind: 'file',
    status: 'R',
    path: '日本語 空白/#?%.ts',
  });
  assert.equal(parseStatusUri(vscode.Uri.parse(special.toString()))?.path, '日本語 空白/#?%.ts');
  await vscode.commands.executeCommand('vsreview.showFileTree');
  const latestMain = latestFiles.find((node) => node.kind === 'file' && node.file.path === 'main.ts');
  assert.ok(latestMain && latestMain.kind === 'file');
  await vscode.commands.executeCommand('vsreview.openDiff', latestMain);
  const latestDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(latestDiff instanceof vscode.TabInputTextDiff, '差分エディタが開いていません');
  assert.equal(latestDiff.original.scheme, 'file');
  assert.ok(latestDiff.original.path.includes('/revisionArchives/'));
  const latestDiffRef = await api.resolveDocumentRef(latestDiff.original);
  assert.ok(latestDiffRef);
  assert.equal(
    (await vscode.workspace.openTextDocument(latestDiff.original)).getText(),
    (await runGit(latestDiffRef.repo, ['show', `${latestDiffRef.rev}:${latestDiffRef.path}`])).toString('utf8'),
  );
  assert.notEqual(latestDiff.original.fsPath, join(latestMain.repo, 'main.ts'));
  assert.equal(latestDiff.original.query, '');
  assert.equal(latestDiff.modified.scheme, 'file');
  assert.equal(latestDiff.modified.fsPath, join(latestMain.repo, 'main.ts'));
  await vscode.commands.executeCommand('vsreview.files.focus');
  for (const [side, expectedSide] of [
    ['Primary', 'new'],
    ['Secondary', 'old'],
  ] as const) {
    await vscode.commands.executeCommand(`workbench.action.compareEditor.focus${side}Side`);
    await poll(() => {
      const selected = api.filesTree.view.selection[0];
      return Promise.resolve(
        selected?.kind === 'file' && selected.root.side === expectedSide && selected.path === 'main.ts'
          ? true
          : undefined,
      );
    }, `Files の ${expectedSide} 側でフォーカス中ファイルが選択されませんでした`);
  }
  const fileNodes = [...(await api.filesTree.getChildren())];
  let decoratedFiles = 0;
  let unchangedFiles = 0;
  while (fileNodes.length) {
    const node = fileNodes.shift()!;
    const item = api.filesTree.getTreeItem(node);
    assert.ok(item.resourceUri);
    if (node.kind === 'file') {
      assert.equal(item.label, basename(node.path));
    }
    const resource = parseStatusUri(item.resourceUri);
    assert.ok(resource);
    const decoration = api.provideFileDecoration(item.resourceUri);
    if (resource.status) {
      assert.ok(decoration?.color);
      if (resource.kind === 'file') {
        assert.equal(decoration?.badge, resource.status);
        decoratedFiles++;
      }
    } else {
      assert.equal(decoration, undefined);
      if (resource.kind === 'file') {
        unchangedFiles++;
      }
    }
    fileNodes.push(...(await api.filesTree.getChildren(node)));
  }
  assert.ok(decoratedFiles > 0);
  assert.ok(unchangedFiles > 0);
  const nestedFile = nested.find((node) => node.kind === 'file' && node.file.path === 'src/ui/nested.ts');
  assert.ok(nestedFile);
  await vscode.commands.executeCommand('vsreview.openDiff', nestedFile);
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  await poll(() => {
    const selected = api.filesTree.view.selection[0];
    return Promise.resolve(
      selected?.kind === 'file' && selected.path === 'src/ui/nested.ts' && selected.root.side === 'new'
        ? true
        : undefined,
    );
  }, 'Files で入れ子のファイルが選択されませんでした');
  await vscode.commands.executeCommand('vsreview.openDiff', latestMain);
  const document = await vscode.workspace.openTextDocument(latestDiff.modified);
  assert.ok(document.getText().includes("greet('review')"));
  const ts = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(ts);
  await ts.activate();
  const latestDefinition = await definition(latestDiff.modified);
  const destination = 'uri' in latestDefinition ? latestDefinition.uri : latestDefinition.targetUri;
  assert.equal(destination.scheme, 'file');
  assert.equal(destination.fsPath, join(latestMain.repo, 'lib.ts'));
  const historical = commits.find((node) => node.kind === 'commit' && node.commit.subject === 'initial');
  assert.ok(historical && historical.kind === 'commit');
  const historicalFiles = await api.commitsTree.getChildren(historical);
  const historicalMain = historicalFiles.find((node) => node.kind === 'file' && node.file.path === 'main.ts');
  assert.ok(historicalMain && historicalMain.kind === 'file');
  await vscode.commands.executeCommand('vsreview.openDiff', historicalMain);
  const historicalDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(historicalDiff instanceof vscode.TabInputTextDiff);
  assert.equal(historicalDiff.modified.scheme, 'file');
  assert.ok(historicalDiff.modified.path.includes('/revisionArchives/'));
  const historicalDiffRef = await api.resolveDocumentRef(historicalDiff.modified);
  assert.ok(historicalDiffRef);
  assert.equal(
    (await vscode.workspace.openTextDocument(historicalDiff.modified)).getText(),
    (await runGit(historicalDiffRef.repo, ['show', `${historicalDiffRef.rev}:${historicalDiffRef.path}`])).toString(
      'utf8',
    ),
  );
  assert.notEqual(historicalDiff.modified.fsPath, join(latestMain.repo, 'main.ts'));
  const historicalDefinition = await definition(historicalDiff.modified);
  assert.equal(
    ('uri' in historicalDefinition ? historicalDefinition.uri : historicalDefinition.targetUri).fsPath,
    join(dirname(historicalDiff.modified.fsPath), 'lib.ts'),
  );
  const deleted = latestList.find((node) => node.kind === 'file' && node.file.path === 'deleted.ts');
  assert.ok(deleted);
  await vscode.commands.executeCommand('vsreview.openDiff', deleted);
  const deletedDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(deletedDiff instanceof vscode.TabInputTextDiff);
  assert.equal(deletedDiff.original.scheme, 'file');
  assert.ok(deletedDiff.original.path.includes('/revisionArchives/'));
  const deletedDiffRef = await api.resolveDocumentRef(deletedDiff.original);
  assert.ok(deletedDiffRef);
  assert.equal(
    (await vscode.workspace.openTextDocument(deletedDiff.original)).getText(),
    (await runGit(deletedDiffRef.repo, ['show', `${deletedDiffRef.rev}:${deletedDiffRef.path}`])).toString('utf8'),
  );
  assert.notEqual(deletedDiff.original.fsPath, join(latestMain.repo, 'deleted.ts'));
  const deletedDefinition = await definition(deletedDiff.original);
  const deletedDestination = 'uri' in deletedDefinition ? deletedDefinition.uri : deletedDefinition.targetUri;
  assert.equal(deletedDestination.fsPath, join(dirname(deletedDiff.original.fsPath), 'lib.ts'));
  assert.equal((await api.resolveDocumentRef(deletedDiff.original))?.rev, latestMain.parent);
  await vscode.commands.executeCommand('vsreview.showFileList');
  const historicalList = await api.commitsTree.getChildren(historical);
  const historicalPackageMain = historicalList.find(
    (node) => node.kind === 'file' && node.file.path === 'packages/crawler/src/main.ts',
  );
  const latestPackageDeleted = latestList.find(
    (node) => node.kind === 'file' && node.file.path === 'packages/crawler/src/deleted.ts',
  );
  assert.ok(historicalPackageMain && latestPackageDeleted);
  for (const [node, side] of [
    [historicalPackageMain, 'modified'],
    [latestPackageDeleted, 'original'],
  ] as const) {
    await vscode.commands.executeCommand('vsreview.openDiff', node);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff);
    const uri = input[side];
    assert.ok(uri.path.includes('/revisionArchives/'));
    await vscode.window.showTextDocument(uri);
    const result = await definition(uri, 'dependency', 'index.d.ts');
    const target = 'uri' in result ? result.uri : result.targetUri;
    assert.equal(
      await realpath(target.fsPath),
      join(latestMain.repo, 'node_modules/.pnpm/nm-dependency/node_modules/nm-dependency/index.d.ts'),
    );
    assert.equal(await api.resolveDocumentRef(target), undefined);
  }
  await vscode.commands.executeCommand('vsreview.showFileTree');
  await vscode.commands.executeCommand('vsreview.openDiff', latestMain);
  assert.ok((await vscode.workspace.openTextDocument(destination)).getText().includes('function greet'));
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor);
  editor.selection = new vscode.Selection(1, 0, 1, document.lineAt(1).text.length);
  const draft = await createCommentInput();
  await clickCommentInput(draft.uri);
  const body = '引数の境界値を検証してください';
  await vscode.commands.executeCommand('type', { text: body });
  await poll(
    () => Promise.resolve(draft.getText() === body ? true : undefined),
    'コメント入力欄に本文が入りませんでした',
  );
  for (const [side, uri] of [
    ['Secondary', latestDiff.original],
    ['Primary', latestDiff.modified],
  ] as const) {
    await vscode.commands.executeCommand(`workbench.action.compareEditor.focus${side}Side`);
    await waitForActiveEditor(uri, `新規コメント中に ${side} 側へフォーカスが移りませんでした`);
    assert.equal(draft.isClosed, false);
    assert.equal(draft.getText(), body);
  }
  // 差分へ移ると入力欄が隠れるため、クリック前にコメントウィジェットを開く。
  await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
  await clickCommentInput(draft.uri);
  // Ctrl+Enter が実行する submitComment で、主ボタンの修正依頼として保存されることを確かめる。
  await vscode.commands.executeCommand('editor.action.submitComment');
  await poll(
    () => Promise.resolve(api.comments.all[0]?.body === body ? true : undefined),
    '新規コメントを保存できませんでした',
  );
  assert.equal(api.commitsTree.getTreeItem(latestMain).description, '1 コメント');
  assert.equal(api.comments.all[0]?.purpose, 'fix');
  await vscode.commands.executeCommand('vsreview.editComment', api.comments.all[0]);
  const editing = await poll(
    () =>
      Promise.resolve(
        vscode.workspace.textDocuments.find(
          (doc) => doc.uri.scheme === 'comment' && doc !== draft && !doc.isClosed && doc.getText() === body,
        ),
      ),
    '編集入力用文書が作られませんでした',
  );
  let expected = body;
  for (let round = 0; round < 3; round++) {
    for (const [side, uri] of [
      ['Secondary', latestDiff.original],
      ['Primary', latestDiff.modified],
    ] as const) {
      await vscode.commands.executeCommand(`workbench.action.compareEditor.focus${side}Side`);
      await waitForActiveEditor(uri, `差分の ${side} 側にフォーカスが移りませんでした`);
      assert.equal(editing.isClosed, false);
      assert.equal(editing.getText(), expected);
    }
    await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
    await clickCommentInput(editing.uri);
    await vscode.commands.executeCommand('cursorBottom');
    const suffix = ` ${round + 1}`;
    expected += suffix;
    await vscode.commands.executeCommand('type', { text: suffix });
    await poll(
      () => Promise.resolve(editing.getText() === expected ? true : undefined),
      '左右切替後の入力欄へ打鍵できませんでした',
    );
  }
  await vscode.commands.executeCommand('editor.action.submitComment');
  await poll(
    () => Promise.resolve(api.comments.all[0]?.body === expected ? true : undefined),
    '入力した本文が保存されませんでした',
  );
  assert.equal(api.comments.all.length, 1);
  assert.equal(api.comments.all[0]?.side, 'new');
  await vscode.commands.executeCommand('vsreview.exportComments', { scope: 'all', format: 'markdown' });
  const requestedOutput = vscode.window.activeTextEditor?.document;
  assert.ok(requestedOutput?.isUntitled);
  assert.ok(requestedOutput.getText().includes('引数の境界値を検証してください'));
  assert.ok(requestedOutput.getText().includes('位置: new L2-L2'));
  assert.ok(requestedOutput.getText().includes(latestMain.commit.hash));
  assert.ok(requestedOutput.getText().includes('新しいコミットを追加せず'));
  assert.ok(requestedOutput.getText().includes('git commit --fixup=<hash>'));
  assert.ok(requestedOutput.getText().includes('GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <hash>^'));
  assert.ok(requestedOutput.getText().includes('GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --root'));
  assert.equal(await vscode.env.clipboard.readText(), requestedOutput.getText());
  const resolvedBody = '解決済みの確認事項';
  await vscode.commands.executeCommand('vsreview.openDiff', latestMain);
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  const resolvedEditor = vscode.window.activeTextEditor;
  assert.ok(resolvedEditor);
  resolvedEditor.selection = new vscode.Selection(0, 0, 0, resolvedEditor.document.lineAt(0).text.length);
  const resolvedDraft = await createCommentInput();
  await clickCommentInput(resolvedDraft.uri);
  await vscode.commands.executeCommand('type', { text: resolvedBody });
  await poll(
    () => Promise.resolve(resolvedDraft.getText() === resolvedBody ? true : undefined),
    '解決済みにするコメントの本文が入力されませんでした',
  );
  await vscode.commands.executeCommand('editor.action.submitComment');
  const resolved = await poll(
    () => Promise.resolve(api.comments.all.find((comment) => comment.body === resolvedBody)),
    '解決済みにするコメントを保存できませんでした',
  );
  await vscode.commands.executeCommand('vsreview.toggleResolved', resolved);
  assert.equal(api.comments.all.find((comment) => comment.id === resolved.id)?.resolved, true);
  await vscode.commands.executeCommand('vsreview.comments.focus');
  const copyGroup = api.commentsTree
    .getChildren()
    .find((node) => node.kind === 'group' && node.comments.some((c) => c.id === resolved.id));
  assert.ok(copyGroup && copyGroup.kind === 'group');
  const documentsBeforeCopy = vscode.workspace.textDocuments.map((doc) => doc.uri.toString()).sort();
  const tabsBeforeCopy = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  await vscode.env.clipboard.writeText('before context copy');
  await clickWorkbenchElement(
    visibleElementExpression(
      `(() => {
        const pane = [...document.querySelectorAll('.pane')].find(pane =>
          pane.querySelector('.pane-header')?.textContent.includes('Review Comments'));
        return [...(pane?.querySelectorAll('.monaco-list-row') ?? [])].find(row =>
          row.textContent.includes(${JSON.stringify(copyGroup.label)}));
      })()`,
      'コピー対象のコメントグループが表示されませんでした',
    ),
    'right',
  );
  await clickWorkbenchElement(
    visibleElementExpression(
      `[...document.querySelectorAll('.context-view .action-label')].find(element => element.textContent.includes('指示をクリップボードにコピー'))`,
      '「指示をクリップボードにコピー」のメニューが表示されませんでした',
    ),
  );
  const copySelected = copyGroup.comments.filter((c) => !c.resolved);
  assert.equal(copySelected.length, 1);
  const currentBranch = (await runGit(copySelected[0]!.repoRoot, ['symbolic-ref', '--short', 'HEAD']))
    .toString('utf8')
    .trim();
  const expectedCopy = exportMarkdown(copySelected, new Map([[copySelected[0]!.repoRoot, currentBranch]]));
  await poll(
    async () => ((await vscode.env.clipboard.readText()) !== 'before context copy' ? true : undefined),
    '右クリックからの指示がクリップボードにコピーされませんでした',
  );
  assert.equal(await vscode.env.clipboard.readText(), expectedCopy);
  assert.ok(!expectedCopy.includes(resolvedBody));
  assert.deepEqual(vscode.workspace.textDocuments.map((doc) => doc.uri.toString()).sort(), documentsBeforeCopy);
  assert.deepEqual(
    vscode.window.tabGroups.all.flatMap((group) => group.tabs),
    tabsBeforeCopy,
  );
  await vscode.env.clipboard.writeText('before interactive export');
  await vscode.commands.executeCommand('vsreview.comments.focus');
  try {
    // view/title が渡す引数とメニュー登録を含めて確かめるため、実ボタンを押す。
    await clickWorkbenchElement(
      visibleElementExpression(
        `(() => {
      const pane = [...document.querySelectorAll('.pane')].find(element =>
        element.querySelector('.pane-header')?.textContent.includes('Review Comments'));
      return pane?.querySelector('.pane-header .codicon-export');
    })()`,
        'Review Comments のエクスポートボタンが表示されませんでした',
      ),
    );
    await selectQuickPick('エクスポート範囲', '未解決のみ');
    await selectQuickPick('エクスポート形式', 'JSON');
    const interactiveOutput = await poll(() => {
      const doc = vscode.window.activeTextEditor?.document;
      return Promise.resolve(doc?.isUntitled && doc.languageId === 'json' ? doc : undefined);
    }, '対話選択した JSON が開きませんでした');
    assert.notEqual(interactiveOutput.uri.toString(), requestedOutput.uri.toString());
    const exported = JSON.parse(interactiveOutput.getText()) as { comments: unknown[] };
    assert.deepEqual(
      exported.comments,
      api.comments.all.filter((comment) => !comment.resolved),
    );
    assert.equal(exported.comments.length, 1);
    await poll(
      async () => ((await vscode.env.clipboard.readText()) === interactiveOutput.getText() ? true : undefined),
      '対話選択の出力がクリップボードにコピーされませんでした',
    );
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  }
  await vscode.commands.executeCommand('vsreview.refreshPullRequests');
  await vscode.commands.executeCommand('vsreview.pullRequests.focus');
  const prNode = (await api.pullRequestsTree.getChildren())[0];
  assert.ok(prNode && prNode.kind === 'pullRequest');
  await api.pullRequestsTree.view.reveal(prNode, { expand: true, select: true });
  const prFiles = await api.pullRequestsTree.getChildren(prNode);
  assert.ok(prFiles.some((node) => node.kind === 'file'));
  await vscode.commands.executeCommand('vsreview.openPullRequest', prNode);
  const prDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(prDiff instanceof vscode.TabInputTextDiff);
  const prRef = await api.resolveDocumentRef(prDiff.original);
  assert.ok(prRef?.pullRequest);
  await vscode.commands.executeCommand('vsreview.files.focus');
  await poll(async () => {
    const roots = await api.filesTree.getChildren();
    return roots.length === 2 &&
      roots.every(
        (root) =>
          root.kind === 'root' &&
          root.snapshot.target.parent === prRef.parent &&
          root.snapshot.target.pullRequest?.number === 12,
      )
      ? true
      : undefined;
  }, 'PR の merge-base が Files に反映されませんでした');
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  await vscode.commands.executeCommand('vsreview.nextFile');
  const nextPrDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(nextPrDiff instanceof vscode.TabInputTextDiff);
  assert.notEqual(nextPrDiff.original.toString(), prDiff.original.toString());
  assert.equal((await api.resolveDocumentRef(nextPrDiff.original))?.pullRequest?.number, 12);
  await vscode.commands.executeCommand('vsreview.previousFile');
  const previousPrDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(previousPrDiff instanceof vscode.TabInputTextDiff);
  assert.equal(previousPrDiff.original.toString(), prDiff.original.toString());
  // 削除ファイルの新側には本文がないため、コメントは新側に内容があるファイルで確認する。
  const prMain = prFiles.find((node) => node.kind === 'file' && node.file.path === 'main.ts');
  assert.ok(prMain);
  await vscode.commands.executeCommand('vsreview.openDiff', prMain);
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  const prEditor = vscode.window.activeTextEditor;
  assert.ok(prEditor);
  prEditor.selection = new vscode.Selection(0, 0, 0, prEditor.document.lineAt(0).text.length);
  const prDraft = await createCommentInput();
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'PR comment input' }));
  await clickCommentInput(prDraft.uri);
  const prBody = 'この引数の根拠は何ですか';
  await vscode.commands.executeCommand('type', { text: prBody });
  await poll(
    () => Promise.resolve(prDraft.getText() === prBody ? true : undefined),
    'PR コメントの本文が入力されませんでした',
  );
  await clickCommentSaveButton(prDraft.uri, 'question');
  const prComment = await poll(
    () =>
      Promise.resolve(
        api.comments.all.find((comment) => comment.pullRequest?.number === 12 && comment.body === prBody),
      ),
    'PR コメントを保存できませんでした',
  );
  assert.equal(prComment.pullRequest?.title, 'E2E PR review');
  assert.equal(prComment.purpose, 'question');
  // コメントスレッドのメニュー登録を含めて確かめるため、実ボタンを押す。
  await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
  for (const purpose of ['fix', 'question'] as const) {
    await clickWorkbenchElement(
      visibleElementExpression(
        `[...document.querySelectorAll('.review-widget')].find(widget =>
          widget.textContent.includes(${JSON.stringify(prBody)}))?.querySelector('.codicon-arrow-swap')`,
        '保存済み PR コメントの種別切り替えボタンが表示されませんでした',
      ),
    );
    await poll(
      () =>
        Promise.resolve(
          api.comments.all.find((comment) => comment.id === prComment.id)?.purpose === purpose ? true : undefined,
        ),
      `PR コメントの種別が${commentPurposeLabel(purpose)}になりませんでした`,
    );
  }
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'PR question export' }));
  const questionExport = vscode.commands.executeCommand('vsreview.exportComments');
  await selectQuickPick('エクスポート範囲', '特定の PR');
  await selectQuickPick('PR を選択', 'PR #12 E2E PR review');
  await selectQuickPick('エクスポート形式', 'Markdown');
  await questionExport;
  const question = vscode.window.activeTextEditor?.document.getText();
  assert.ok(question);
  assert.ok(question.includes('### PR #12 "E2E PR review"'));
  assert.ok(question.includes('コードやコミットを変更せず'));
  assert.ok(question.includes('この引数の根拠は何ですか'));
  assert.ok(question.includes('種別: 質問'));
  assert.ok(!question.includes('push してください'));
  assert.ok(!question.includes('fixup'));
  // 拡張のコマンドを使わず別プロセスで amend し、worktree 外の refs の監視を確かめる。
  await commitAll(latestMain.repo, 'amended by agent', { amend: true });
  const amended = await poll(async () => {
    const current = await api.commitsTree.getChildren();
    const head = current[0];
    if (head?.kind !== 'commit' || head.commit.subject !== 'amended by agent') {
      return undefined;
    }
    assert.notEqual(head.commit.hash, latestMain.commit.hash);
    assert.ok(!current.some((node) => node.kind === 'commit' && node.commit.hash === latestMain.commit.hash));
    return head;
  }, 'worktree の外部 amend が自動でコミット一覧に反映されませんでした');
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'uncommitted files' }));
  await writeFile(
    join(latestMain.repo, 'lib.ts'),
    'export function greet(name: string): string { return name.trim(); }\n',
  );
  await runGit(latestMain.repo, ['add', 'lib.ts']);
  const working = "import { greet } from './lib';\nconst name = 'uncommitted';\nconsole.log(greet(name));\n";
  await writeFile(join(latestMain.repo, 'main.ts'), working);
  await writeFile(join(latestMain.repo, 'untracked.ts'), 'export const untracked = true;\n');
  await writeFile(join(latestMain.repo, 'node_modules/ignored-out.js'), 'ignored\n');
  await vscode.commands.executeCommand('vsreview.showFileList');
  const unstagedMain = await poll(async () => {
    const root = (await api.commitsTree.getChildren())[0];
    if (root?.kind !== 'uncommitted') {
      return undefined;
    }
    const groups = await api.commitsTree.getChildren(root);
    const staged = groups.find((node) => node.kind === 'uncommittedGroup' && node.change.kind === 'staged');
    const unstaged = groups.find((node) => node.kind === 'uncommittedGroup' && node.change.kind === 'unstaged');
    if (!staged || !unstaged) {
      return undefined;
    }
    const stagedFiles = await api.commitsTree.getChildren(staged);
    const unstagedFiles = await api.commitsTree.getChildren(unstaged);
    if (
      !stagedFiles.some((node) => node.kind === 'file' && node.file.path === 'lib.ts' && node.file.status === 'M') ||
      !unstagedFiles.some(
        (node) => node.kind === 'file' && node.file.path === 'untracked.ts' && node.file.status === 'A',
      )
    ) {
      return undefined;
    }
    assert.equal(api.commitsTree.getTreeItem(root).label, '未コミットの変更');
    assert.ok(
      [...stagedFiles, ...unstagedFiles].every(
        (node) => node.kind !== 'file' || !node.file.path.startsWith('node_modules/'),
      ),
    );
    return unstagedFiles.find(
      (node) => node.kind === 'file' && node.file.path === 'main.ts' && node.file.status === 'M',
    );
  }, '未コミットの区分とファイルが自動更新されませんでした');
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'uncommitted comment' }));
  await vscode.commands.executeCommand('vsreview.openDiff', unstagedMain);
  await vscode.commands.executeCommand('workbench.action.compareEditor.focusPrimarySide');
  const uncommittedEditor = vscode.window.activeTextEditor;
  assert.ok(uncommittedEditor);
  uncommittedEditor.selection = new vscode.Selection(2, 0, 2, uncommittedEditor.document.lineAt(2).text.length);
  const uncommittedDraft = await createCommentInput();
  await clickCommentInput(uncommittedDraft.uri);
  const uncommittedBody = '未ステージの3行目を確認してください';
  await vscode.commands.executeCommand('type', { text: uncommittedBody });
  await poll(
    () => Promise.resolve(uncommittedDraft.getText() === uncommittedBody ? true : undefined),
    '未ステージのコメントを入力できませんでした',
  );
  await clickCommentSaveButton(uncommittedDraft.uri, 'fix');
  const uncommittedComment = await poll(
    () => Promise.resolve(api.comments.all.find((comment) => comment.body === uncommittedBody)),
    '未ステージのコメントを保存できませんでした',
  );
  assert.equal(uncommittedComment.uncommitted?.kind, 'unstaged');
  assert.equal(uncommittedComment.purpose, 'fix');
  assert.equal(uncommittedComment.startLine, 3);
  const tabBeforeEdit = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(tabBeforeEdit instanceof vscode.TabInputTextDiff);
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'uncommitted changed' }));
  await writeFile(join(latestMain.repo, 'main.ts'), working.replace('uncommitted', 'edited after comment'));
  await poll(
    () =>
      Promise.resolve(
        String(api.commentsTree.getTreeItem({ kind: 'comment', comment: uncommittedComment }).description).includes(
          '内容が変更済み',
        )
          ? true
          : undefined,
      ),
    '未コミットの変更済み表示が自動更新されませんでした',
  );
  const tabAfterEdit = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(tabAfterEdit instanceof vscode.TabInputTextDiff);
  assert.equal(tabAfterEdit.original.toString(), tabBeforeEdit.original.toString());
  assert.equal(tabAfterEdit.modified.toString(), tabBeforeEdit.modified.toString());
  await vscode.commands.executeCommand('vsreview.exportComments', { scope: 'uncommitted', format: 'markdown' });
  const uncommittedOutput = vscode.window.activeTextEditor?.document;
  assert.ok(uncommittedOutput?.isUntitled);
  const uncommittedText = uncommittedOutput.getText();
  assert.ok(uncommittedText.includes('### 未コミットの変更（未ステージ）'));
  assert.ok(uncommittedText.includes('内容が変更済み: はい'));
  assert.ok(uncommittedText.includes('未コミットのコメントに対して:'));
  assert.ok(!uncommittedText.includes('fixup'));
  assert.equal(await vscode.env.clipboard.readText(), uncommittedText);
  await vscode.commands.executeCommand('vsreview.openComment', uncommittedComment);
  const savedDiff = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(savedDiff instanceof vscode.TabInputTextDiff);
  assert.equal((await api.resolveDocumentRef(savedDiff.modified))?.commit.hash, uncommittedComment.commit);
  await waitForActiveEditor(savedDiff.modified, '保存時点の差分が開きませんでした');
  assert.equal(vscode.window.activeTextEditor?.selection.start.line, 2);
  assert.equal((await vscode.workspace.openTextDocument(savedDiff.modified)).getText(), working);
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'commit explanations' }));
  const explanationCommit = (await api.commitsTree.getChildren()).find(
    (node) => node.kind === 'commit' && node.commit.hash === amended.commit.hash,
  );
  assert.ok(explanationCommit && explanationCommit.kind === 'commit');
  const explanationFiles = await api.commitsTree.getChildren(explanationCommit);
  const explanationMain = explanationFiles.find((node) => node.kind === 'file' && node.file.path === 'main.ts');
  assert.ok(explanationMain && explanationMain.kind === 'file');
  const explanationNested = explanationFiles.find(
    (node) => node.kind === 'file' && node.file.path === 'src/ui/nested.ts',
  );
  assert.ok(explanationNested && explanationNested.kind === 'file');
  await checkExplanations(api, explanationCommit, explanationMain, explanationNested);
  await writeFile(resultFile, JSON.stringify({ status: 'started', step: 'commit explanation failure' }));
  // 再生成の確認ダイアログで自動操作が止まるため、失敗の検証は未生成のコミットを使う。
  // 再生成に失敗しても以前の解説が残ることは test/reviewExplanations.test.ts で確かめる。
  await checkExplanationFailure(api, historical, historicalMain);
  await writeFile(resultFile, JSON.stringify({ status: 'passed' }));
}
