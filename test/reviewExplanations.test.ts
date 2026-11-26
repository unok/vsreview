import childProcess from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { comparisonKey } from '../src/core/comparisons';
import type { CommitTarget } from '../src/core/documents';
import { ExplanationOutputError, type StoredExplanation } from '../src/core/explanations';
import { AgentCliError, type runAgent } from '../src/git/agentCli';
import { ExplanationStore } from '../src/git/explanationStore';
import { GitClient, GitError, runGit } from '../src/git/client';
import { isBinaryPatch } from '../src/core/diff';
import type { ExplanationAgent } from '../src/core/explanations';
import { shortHash } from '../src/core/presentation';
import {
  NO_CHANGED_FILES,
  RESET_EXPLANATION_PERMISSIONS_TITLE,
  ReviewExplanations,
  explanationTargetLabel,
} from '../src/ui/explanations';
import { accessFor, gitProcesses, repository, temporaryDirectory, workspaceFolder } from './fixtures';
import { hashId, repositoryId } from '../src/git/repositoryId';
import { commitAll, gitAsAuthor } from './gitFixtures';
import { progressCancelled, window } from './vscodeMock';

type Run = typeof runAgent;
// 実物の CLI を呼ばず、プロンプトの ID ごとに解説を返す。
function answering(markdown: (id: string) => string = (id) => `# ${id} の解説`): Mock<Run> {
  return vi.fn<Run>((_agent, prompt) =>
    Promise.resolve(
      JSON.stringify({
        files: [...prompt.matchAll(/^## (F\d+)$/gm)].map(([, id]) => ({ id, markdown: markdown(id!) })),
      }),
    ),
  );
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// 変更・リネーム・削除・バイナリ・サブモジュールを 1 コミットに含める。
async function reviewRepository() {
  const { directory, git } = await repository();
  await writeFile(join(directory, 'changed.ts'), 'export const value = 1;\n');
  await writeFile(join(directory, 'old.ts'), 'export const renamed = true;\n'.repeat(5));
  await writeFile(join(directory, 'gone.ts'), 'export const gone = true;\n');
  await commitAll(directory, 'base');
  const base = (await git.log(0, 1))[0]!;
  await writeFile(join(directory, 'changed.ts'), 'export const value = 2;\n');
  await runGit(directory, ['mv', 'old.ts', 'new.ts']);
  await rm(join(directory, 'gone.ts'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'assets/image.bin'), Buffer.from([0, 1, 2, 0, 255]));
  await runGit(directory, ['add', '-A']);
  await runGit(directory, ['update-index', '--add', '--cacheinfo', `160000,${base.hash},sub`]);
  await gitAsAuthor(directory, ['commit', '-m', 'review target']);
  const commit = (await git.log(0, 1))[0]!;
  const target: CommitTarget = { repo: git.root, commit, parent: await git.parent(commit) };
  return { directory, git, target, files: await git.files(commit), access: await accessFor(directory) };
}
async function service(
  options: {
    run?: Mock<Run>;
    allowed?: () => Promise<boolean>;
    denied?: boolean;
    agent?: () => ExplanationAgent;
  } = {},
) {
  const fixture = await reviewRepository();
  const store = new ExplanationStore(undefined);
  const write = vi.spyOn(store, 'write');
  const permissions = {
    allowed: vi.fn(options.allowed ?? (() => Promise.resolve(true))),
    denied: vi.fn(() => Promise.resolve(options.denied ?? false)),
  };
  const run = options.run ?? answering();
  const explanations = new ReviewExplanations({
    access: fixture.access,
    store,
    permissions,
    run,
    ...(options.agent ? { agent: options.agent } : {}),
  });
  return { ...fixture, store, write, permissions, run, explanations };
}
async function saved(store: ExplanationStore, target: CommitTarget): Promise<StoredExplanation | undefined> {
  const read = await store.read(target.repo, comparisonKey(target));
  return read.kind === 'found' ? read.explanation : undefined;
}

describe('ReviewExplanations', () => {
  it('変更・リネーム・削除の diff を送り、バイナリとサブモジュールは理由付きで外して保存する', async () => {
    const { explanations, target, files, run, store } = await service();
    await explanations.generate(target, files);
    expect(run).toHaveBeenCalledOnce();
    const [agent, prompt, options] = run.mock.calls[0]!;
    expect(agent).toBe('claude');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(prompt).toContain('ファイル: "changed.ts"');
    expect(prompt).toContain('-export const value = 1;\n+export const value = 2;');
    expect(prompt).toContain('ファイル: "new.ts"\n\nステータス: R\n\n変更元: "old.ts"');
    expect(prompt).toContain('ファイル: "gone.ts"\n\nステータス: D');
    expect(prompt).not.toContain('image.bin');
    expect(prompt).not.toContain('"sub"');
    const record = await saved(store, target);
    expect(record?.files).toEqual(
      expect.arrayContaining([
        { status: 'A', path: 'assets/image.bin', skipped: 'binary' },
        { status: 'A', path: 'sub', skipped: 'submodule' },
        expect.objectContaining({ path: 'changed.ts', markdown: expect.stringMatching(/^# F\d の解説$/) as string }),
        expect.objectContaining({ path: 'new.ts', oldPath: 'old.ts' }),
        expect.objectContaining({ path: 'gone.ts', status: 'D' }),
      ]),
    );
    expect(record?.files).toHaveLength(files.length);
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: 解説を保存しました', 5000);
    expect(explanations.failure(target)).toBeUndefined();
  });

  it('Git がテキストの差分を出しても NUL を含むファイルは送らない', async () => {
    const { directory, git, explanations, target, run, store } = await service();
    await writeFile(join(directory, '.gitattributes'), 'forced.txt diff\n');
    await writeFile(join(directory, 'forced.txt'), 'text\0');
    await commitAll(directory, 'force text diff');
    const commit = (await git.log(0, 1))[0]!;
    const comparison = { ...target, commit, parent: target.commit.hash };
    const files = await git.files(commit);
    const file = files.find(({ path }) => path === 'forced.txt')!;
    expect(await git.patch(comparison.parent, commit.hash, file)).toContain('+text\0');

    await explanations.generate(comparison, files);
    expect(run.mock.calls[0]?.[1]).toContain('ファイル: ".gitattributes"');
    expect(run.mock.calls[0]?.[1]).not.toContain('ファイル: "forced.txt"');
    expect((await saved(store, comparison))?.files).toContainEqual({ ...file, skipped: 'binary' });
  });

  it('パッチの末尾にだけ NUL がある場合も省略理由を保存する', async () => {
    const { explanations, target, files, run, store } = await service();
    const file = files.find(({ path }) => path === 'changed.ts')!;
    vi.spyOn(GitClient.prototype, 'patch').mockResolvedValueOnce('@@ -1 +1 @@\n-old\n+new\0');

    await explanations.generate(target, [file]);
    expect(run).not.toHaveBeenCalled();
    expect((await saved(store, target))?.files).toEqual([{ ...file, skipped: 'binary' }]);
  });

  it('Git の出力上限を超えたファイルだけを省略し、他の解説を保存する', async () => {
    const { explanations, target, files, run, store } = await service();
    const execFile = childProcess.execFile;
    gitProcesses().mockImplementation((command, args, options, callback) => {
      const limit = args?.includes('diff') && args.some((arg) => arg.endsWith(':changed.ts'));
      return execFile(command, args, limit ? { ...options, maxBuffer: 1 } : options, callback);
    });

    await explanations.generate(target, files);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[1]).toContain('ファイル: "gone.ts"');
    expect(run.mock.calls[0]?.[1]).not.toContain('ファイル: "changed.ts"');
    expect((await saved(store, target))?.files).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'changed.ts', skipped: 'tooLarge' },
        expect.objectContaining({ path: 'gone.ts', markdown: expect.any(String) as string }),
      ]),
    );
    expect(explanations.failure(target)).toBeUndefined();
  });

  it('パッチの取得が出力上限超過以外の Git エラーで失敗したら解説を保存しない', async () => {
    const { explanations, target, files, run, store } = await service();
    const error = new GitError(['diff'], 'stdout maxBuffer length exceeded', 128);
    vi.spyOn(GitClient.prototype, 'patch').mockRejectedValueOnce(error);

    await explanations.generate(target, files);
    expect(run).not.toHaveBeenCalled();
    expect(await saved(store, target)).toBeUndefined();
    expect(explanations.failure(target)).toBe(error.message);
  });

  it('捨てた ID・欠けた ID・不正な解説の件数をステータスに出す', async () => {
    const run = vi.fn<Run>(() =>
      Promise.resolve(
        JSON.stringify({
          files: [
            { id: 'F1', markdown: 'a' },
            { id: 'F2', markdown: ' ' },
            { id: 'F99', markdown: 'x' },
          ],
        }),
      ),
    );
    const { explanations, target, files, store } = await service({ run });
    await explanations.generate(target, files);
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      'VSReview: 解説を保存しました（依頼していない 1 件を捨てました、1 件は出力に含まれませんでした、1 件は出力が不正でした）',
      5000,
    );
    expect((await saved(store, target))?.files.filter((file) => 'skipped' in file).map((file) => file.skipped)).toEqual(
      expect.arrayContaining(['invalid', 'missing']),
    );
  });

  it('変更 0 件なら CLI を起動せず、許可も確かめずに通知する', async () => {
    const { explanations, target, run, write, permissions } = await service();
    await explanations.generate(target, []);
    expect(window.showInformationMessage).toHaveBeenCalledWith(`VSReview: ${NO_CHANGED_FILES}`);
    expect(run).not.toHaveBeenCalled();
    expect(permissions.allowed).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('送れるファイルがなければ CLI を起動せず、省略理由だけを保存する', async () => {
    const { explanations, target, files, run, store } = await service();
    await explanations.generate(
      target,
      files.filter((file) => file.path === 'assets/image.bin' || file.path === 'sub'),
    );
    expect(run).not.toHaveBeenCalled();
    expect((await saved(store, target))?.files).toEqual([
      { status: 'A', path: 'assets/image.bin', skipped: 'binary' },
      { status: 'A', path: 'sub', skipped: 'submodule' },
    ]);
  });

  it.each([
    ['CLI がない', new AgentCliError('spawn', 'PATH に claude 実行ファイルが見つかりません')],
    ['非ゼロ終了', new AgentCliError('exit', 'claude が終了コード 1 で失敗しました: Not logged in')],
    ['タイムアウト', new AgentCliError('timeout', 'claude の応答が時間内に終わりませんでした')],
  ])('%s は何も保存せず通知し、失敗を記録する', async (_, error) => {
    const { explanations, target, files, write } = await service({ run: vi.fn<Run>(() => Promise.reject(error)) });
    await explanations.generate(target, files);
    expect(write).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith(`VSReview: ${error.message}`);
    expect(explanations.failure(target)).toBe(error.message);
  });

  it('出力が不正なら何も保存せず通知する', async () => {
    const { explanations, target, files, write } = await service({ run: vi.fn<Run>(() => Promise.resolve('Sorry')) });
    await explanations.generate(target, files);
    expect(write).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      `VSReview: ${new ExplanationOutputError('JSON として読めません').message}`,
    );
  });

  it('再生成が失敗したら既存の解説を残し、成功したら置き換えて失敗の記録を消す', async () => {
    const run = answering(() => '古い解説');
    const { explanations, target, files, store } = await service({ run });
    await explanations.generate(target, files);
    run.mockRejectedValueOnce(new AgentCliError('exit', 'claude が終了コード 1 で失敗しました'));
    await explanations.generate(target, files);
    expect(JSON.stringify(await saved(store, target))).toContain('古い解説');
    expect(explanations.failure(target)).toBe('claude が終了コード 1 で失敗しました');
    run.mockImplementation(answering(() => '新しい解説'));
    await explanations.generate(target, files);
    const record = JSON.stringify(await saved(store, target));
    expect(record).toContain('新しい解説');
    expect(record).not.toContain('古い解説');
    expect(explanations.failure(target)).toBeUndefined();
  });

  it('同じ比較の生成中に再実行されたら同じ生成を共有し、生成中の状態と変更を通知する', async () => {
    const output = deferred<string>();
    const run = vi.fn<Run>(() => output.promise);
    const { explanations, target, files, write, store } = await service({ run });
    const changed = vi.fn();
    explanations.onDidChange(changed);
    const first = explanations.generate(target, files);
    const second = explanations.generate(target, files);
    expect(explanations.isGenerating(target)).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    output.resolve(await answering()('claude', run.mock.calls[0]![1]));
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect((await saved(store, target))?.files).toHaveLength(files.length);
    expect(explanations.isGenerating(target)).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it('別の比較の生成は順番に実行する', async () => {
    const started = deferred<string>();
    const output = deferred<string>();
    const run = answering().mockImplementationOnce((_agent, prompt) => {
      started.resolve(prompt);
      return output.promise;
    });
    const { access, explanations, target, files } = await service({ run });
    const other = await reviewRepository();
    await access.discover([workspaceFolder(target.repo), workspaceFolder(other.target.repo)]);
    const order: string[] = [];
    const execFile = childProcess.execFile;
    gitProcesses().mockImplementation((command, args, options, callback) => {
      if (args?.includes(other.target.repo) && !order.includes('2 件目の Git 起動')) {
        order.push('2 件目の Git 起動');
      }
      return execFile(command, args, options, callback);
    });
    const first = explanations.generate(target, files).then(() => {
      order.push('1 件目の生成完了');
    });
    const second = explanations.generate(other.target, other.files);
    output.resolve(await answering()('claude', await started.promise));
    await Promise.all([first, second]);
    expect(order).toEqual(['1 件目の生成完了', '2 件目の Git 起動']);
  });

  it.each(['キャンセル', 'dispose'] as const)('%s で実行中の生成を中断し、何も保存しない', async (how) => {
    const run = vi.fn<Run>(
      (_agent, _prompt, options) =>
        new Promise((_, reject) =>
          options?.signal?.addEventListener('abort', () =>
            reject(new AgentCliError('aborted', 'claude の実行を中断しました')),
          ),
        ),
    );
    const { explanations, target, files, write } = await service({ run });
    const pending = explanations.generate(target, files);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    if (how === 'キャンセル') {
      progressCancelled.fire();
    } else {
      explanations.dispose();
    }
    await pending;
    expect(run.mock.calls[0]![2]?.signal?.aborted).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(explanations.failure(target)).toBeUndefined();
    if (how === 'キャンセル') {
      expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: 解説の生成を中断しました', 5000);
    } else {
      expect(window.setStatusBarMessage).not.toHaveBeenCalled();
    }
  });

  it('CLI の終了後・保存前に取り消されたら、出力があっても保存しない', async () => {
    // 有効な解説を返すので、保存前の取り消しの確認がなければ保存される。
    const answer = answering();
    const run = vi.fn<Run>((...args) => {
      progressCancelled.fire();
      return answer(...args);
    });
    const { explanations, target, files, write } = await service({ run });
    await explanations.generate(target, files);
    expect(write).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: 解説の生成を中断しました', 5000);
  });

  it('シグナルが中断されていなくても、CLI が中断を返したら失敗として記録しない', async () => {
    const run = vi.fn<Run>(() => Promise.reject(new AgentCliError('aborted', 'claude の実行を中断しました')));
    const { explanations, target, files, write } = await service({ run });
    await explanations.generate(target, files);
    expect(write).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    expect(explanations.failure(target)).toBeUndefined();
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: 解説の生成を中断しました', 5000);
  });

  it('削除されたサブモジュールも送らない', async () => {
    const { explanations, directory, git, run, store } = await service();
    await runGit(directory, ['rm', '--cached', 'sub']);
    await gitAsAuthor(directory, ['commit', '-m', 'remove submodule']);
    const commit = (await git.log(0, 1))[0]!;
    const target: CommitTarget = { repo: git.root, commit, parent: await git.parent(commit) };
    await explanations.generate(target, await git.files(commit));
    expect(run).not.toHaveBeenCalled();
    expect((await saved(store, target))?.files).toEqual([{ status: 'D', path: 'sub', skipped: 'submodule' }]);
  });

  it('dispose の後は生成しない', async () => {
    const { explanations, target, files, run } = await service();
    explanations.dispose();
    await explanations.generate(target, files);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    '許可されなければ実行せず、拒否済み（%s）のときだけリセットのコマンドを案内する',
    async (denied) => {
      const { explanations, target, files, run, write, permissions } = await service({
        allowed: () => Promise.resolve(false),
        denied,
      });
      await explanations.generate(target, files);
      expect(permissions.allowed).toHaveBeenCalledWith(target.repo, 'claude');
      expect(permissions.denied).toHaveBeenCalledWith(target.repo, 'claude');
      if (denied) {
        expect(window.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
          `VSReview: claude への差分の送信を拒否しています。「${RESET_EXPLANATION_PERMISSIONS_TITLE}」で選び直せます`,
        );
      } else {
        expect(window.showInformationMessage).not.toHaveBeenCalled();
      }
      expect(RESET_EXPLANATION_PERMISSIONS_TITLE).toBe('VSReview: 解説のための差分送信の許可・拒否をリセット');
      expect(run).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    '許可の確認中に dispose されたら、応答が %s でも差分を取得せず送らず、案内も出さない',
    async (answer) => {
      const response = deferred<boolean>();
      const { explanations, target, files, run, write, permissions } = await service({
        allowed: () => response.promise,
        denied: true,
      });
      const patch = vi.spyOn(GitClient.prototype, 'patch');
      const pending = explanations.generate(target, files);
      await vi.waitFor(() => expect(permissions.allowed).toHaveBeenCalledOnce());
      explanations.dispose();
      response.resolve(answer);
      await pending;
      expect(window.withProgress).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(permissions.denied).not.toHaveBeenCalled();
      expect(window.showInformationMessage).not.toHaveBeenCalled();
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    },
  );

  it('許可の保存に失敗したら送らず、通知して失敗を記録する', async () => {
    const { explanations, target, files, run } = await service({
      allowed: () => Promise.reject(new Error('許可を保存できません')),
    });
    await explanations.generate(target, files);
    expect(run).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: 許可を保存できません');
    expect(explanations.failure(target)).toBe('許可を保存できません');
  });

  it.each([
    ['差分の取得', 'patch', 'patch に失敗'],
    ['サブモジュールの判定', 'isSubmoduleChange', 'ls-tree に失敗'],
  ] as const)('%s が失敗したら CLI を起動せず、通知して失敗を記録する', async (_, method, message) => {
    const { explanations, target, files, run, write } = await service();
    vi.spyOn(GitClient.prototype, method).mockRejectedValue(new Error(message));
    await explanations.generate(target, files);
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(window.showErrorMessage).toHaveBeenCalledWith(`VSReview: ${message}`);
    expect(explanations.failure(target)).toBe(message);
  });

  it('保存が失敗したら通知して失敗を記録する', async () => {
    const { explanations, target, files, write } = await service();
    write.mockRejectedValueOnce(new Error('保存できません'));
    await explanations.generate(target, files);
    expect(window.showErrorMessage).toHaveBeenCalledWith('VSReview: 保存できません');
    expect(explanations.failure(target)).toBe('保存できません');
  });

  it('差分の収集中に取り消されたら、以後の差分を取得せず、CLI を起動せず保存しない', async () => {
    const { explanations, directory, git, run, write } = await service();
    // 並列数より多いファイルを変更する。
    for (let index = 0; index < 20; index++) {
      await writeFile(join(directory, `many-${index}.ts`), `export const value${index} = ${index};\n`);
    }
    await commitAll(directory, 'many files');
    const commit = (await git.log(0, 1))[0]!;
    const target: CommitTarget = { repo: git.root, commit, parent: await git.parent(commit) };
    const files = await git.files(commit);
    let callsAtCancel = 0;
    const patch = vi.spyOn(GitClient.prototype, 'patch').mockImplementation(() => {
      if (!callsAtCancel) {
        callsAtCancel = patch.mock.calls.length;
        progressCancelled.fire();
      }
      return Promise.resolve('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n');
    });
    await explanations.generate(target, files);
    expect(callsAtCancel).toBeGreaterThan(0);
    expect(patch).toHaveBeenCalledTimes(callsAtCancel);
    expect(patch.mock.calls.length).toBeLessThan(files.length);
    expect(run).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).toHaveBeenCalledWith('VSReview: 解説の生成を中断しました', 5000);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['空の出力', '{"files":[]}', '（3 件は出力に含まれませんでした）'],
    [
      '全件不正の出力',
      JSON.stringify({ files: ['F1', 'F2', 'F3'].map((id) => ({ id, markdown: ' ' })) }),
      '（3 件は出力が不正でした）',
    ],
  ])('有効な解説が 1 件もない %s は失敗とし、初回は保存せず、再生成では既存を残す', async (_, output, counts) => {
    const run = answering(() => '既存の解説');
    const { explanations, target, files, store, write } = await service({
      run: vi.fn<Run>(() => Promise.resolve(output)),
    });
    await explanations.generate(target, files);
    expect(write).not.toHaveBeenCalled();
    const message = `解説が 1 件も得られませんでした${counts}`;
    expect(window.showErrorMessage).toHaveBeenCalledWith(`VSReview: ${message}`);
    expect(explanations.failure(target)).toBe(message);
    const regenerate = new ReviewExplanations({
      access: { client: (repo) => new GitClient(repo) },
      store,
      permissions: { allowed: () => Promise.resolve(true), denied: () => Promise.resolve(false) },
      run,
    });
    await regenerate.generate(target, files);
    run.mockResolvedValue(output);
    await regenerate.generate(target, files);
    expect(JSON.stringify(await saved(store, target))).toContain('既存の解説');
    expect(regenerate.failure(target)).toBe(message);
  });

  it('変更の通知の中で同じ比較の生成を呼んでも、通知を繰り返さない', async () => {
    const { explanations, target, files, run } = await service();
    // 生成の開始の通知の中で、同じ比較の生成をもう一度呼ぶ。
    const changed = vi.fn(() => {
      if (changed.mock.calls.length === 1) {
        void explanations.generate(target, files);
      }
    });
    explanations.onDidChange(changed);
    await explanations.generate(target, files);
    expect(run).toHaveBeenCalledOnce();
    // 開始と終了の 2 回だけ。
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('注入したエージェントを許可・実行・保存レコードへ渡す', async () => {
    const agent = 'other' as ExplanationAgent;
    const { explanations, target, files, run, write, permissions } = await service({ agent: () => agent });
    write.mockResolvedValue();
    await explanations.generate(target, files);
    expect(permissions.allowed).toHaveBeenCalledWith(target.repo, agent);
    expect(run.mock.calls[0]![0]).toBe(agent);
    expect(write.mock.calls[0]![1].agent).toBe(agent);
  });

  it('プロンプトの各節の ID の解説を、その節のファイルの解説として保存する', async () => {
    const run = vi.fn<Run>((_agent, prompt) =>
      Promise.resolve(
        JSON.stringify({
          files: [...prompt.matchAll(/^## (F\d+)\n\nファイル: "(.*)"$/gm)].map(([, id, path]) => ({
            id,
            markdown: `${path} の解説`,
          })),
        }),
      ),
    );
    const { explanations, target, files, store } = await service({ run });
    await explanations.generate(target, files);
    const explained = (await saved(store, target))?.files.flatMap((file) =>
      'markdown' in file ? [[file.path, file.markdown]] : [],
    );
    expect(explained?.sort()).toEqual(['changed.ts', 'gone.ts', 'new.ts'].map((path) => [path, `${path} の解説`]));
  });

  it('進捗の通知に比較の表示名を出す', async () => {
    const { explanations, target, files } = await service();
    await explanations.generate(target, files);
    expect(window.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `VSReview: ${shortHash(target.commit.hash)} の解説を生成しています`,
        cancellable: true,
      }),
      expect.any(Function),
    );
  });

  it('保存のない比較は読みに行かず none を返す', async () => {
    const { explanations, target, store } = await service();
    const read = vi.spyOn(store, 'read');
    expect(explanations.explanation(target, 'changed.ts')).toEqual({ record: { kind: 'none' }, generating: false });
    expect(explanations.explained(target, 'changed.ts')).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('生成後は記録を読み込んで通知し、解説のあるファイルだけを解説ありとする', async () => {
    const { explanations, target, files, store } = await service();
    await explanations.generate(target, files);
    const read = vi.spyOn(store, 'read');
    const changed = vi.fn();
    explanations.onDidChange(changed);
    expect(explanations.explanation(target, 'changed.ts').record).toEqual({ kind: 'loading' });
    expect(explanations.explained(target, 'changed.ts')).toBe(false);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(explanations.explanation(target, 'changed.ts')).toMatchObject({
      record: { kind: 'found' },
      file: { path: 'changed.ts', markdown: expect.any(String) as string },
      generating: false,
    });
    expect(explanations.explained(target, 'changed.ts')).toBe(true);
    expect(explanations.explanation(target, 'assets/image.bin').file).toEqual({
      status: 'A',
      path: 'assets/image.bin',
      skipped: 'binary',
    });
    expect(explanations.explained(target, 'assets/image.bin')).toBe(false);
    expect(explanations.explanation(target, 'absent.ts').file).toBeUndefined();
    expect(explanations.explained(target, 'absent.ts')).toBe(false);
    // 同じ比較は読み直さない。
    expect(read).toHaveBeenCalledOnce();
    // スナップショットや親が違う比較には付けない。
    expect(
      explanations.explained({ ...target, commit: { ...target.commit, hash: 'c'.repeat(40) } }, 'changed.ts'),
    ).toBe(false);
  });

  it('再生成で保存し直したら、読み込み済みの記録を読み直す', async () => {
    const run = answering(() => '古い解説');
    const { explanations, target, files } = await service({ run });
    await explanations.generate(target, files);
    explanations.explanation(target, 'changed.ts');
    await vi.waitFor(() =>
      expect(explanations.explanation(target, 'changed.ts').file).toMatchObject({ markdown: '古い解説' }),
    );
    run.mockImplementation(answering(() => '新しい解説'));
    await explanations.generate(target, files);
    explanations.explanation(target, 'changed.ts');
    await vi.waitFor(() =>
      expect(explanations.explanation(target, 'changed.ts').file).toMatchObject({ markdown: '新しい解説' }),
    );
  });

  it('生成中と最後の失敗も問い合わせに含める', async () => {
    const output = deferred<string>();
    const run = vi.fn<Run>(() => output.promise);
    const { explanations, target, files } = await service({ run });
    const pending = explanations.generate(target, files);
    expect(explanations.explanation(target, 'changed.ts').generating).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    output.reject(new AgentCliError('exit', 'claude が終了コード 1 で失敗しました'));
    await pending;
    expect(explanations.explanation(target, 'changed.ts')).toEqual({
      record: { kind: 'none' },
      generating: false,
      failure: 'claude が終了コード 1 で失敗しました',
    });
  });

  it('読み込めない保存ファイルは unreadable として返す', async () => {
    const fixture = await reviewRepository();
    const storage = await temporaryDirectory();
    const store = new ExplanationStore(storage);
    const explanations = new ReviewExplanations({
      access: fixture.access,
      store,
      permissions: { allowed: () => Promise.resolve(true), denied: () => Promise.resolve(false) },
      run: answering(),
    });
    await explanations.generate(fixture.target, fixture.files);
    await writeFile(
      join(storage, 'explanations', repositoryId(fixture.target.repo), `${hashId(comparisonKey(fixture.target))}.json`),
      '{',
    );
    explanations.explanation(fixture.target, 'changed.ts');
    await vi.waitFor(() =>
      expect(explanations.explanation(fixture.target, 'changed.ts').record).toEqual({ kind: 'unreadable' }),
    );
    expect(explanations.explained(fixture.target, 'changed.ts')).toBe(false);
  });

  it('読み込みの失敗は一度だけ通知し、load まで読み直さない', async () => {
    const { explanations, target, files, store } = await service();
    await explanations.generate(target, files);
    const read = vi.spyOn(store, 'read').mockRejectedValue(new Error('読み込めません'));
    explanations.explanation(target, 'changed.ts');
    await vi.waitFor(() =>
      expect(explanations.explanation(target, 'changed.ts').record).toEqual({
        kind: 'failed',
        message: '読み込めません',
      }),
    );
    explanations.explanation(target, 'changed.ts');
    expect(read).toHaveBeenCalledOnce();
    expect(window.showErrorMessage).toHaveBeenCalledExactlyOnceWith('VSReview: 読み込めません');
    read.mockRestore();
    await explanations.load(target.repo);
    explanations.explanation(target, 'changed.ts');
    await vi.waitFor(() => expect(explanations.explained(target, 'changed.ts')).toBe(true));
  });

  it('ensureLoaded は索引の読み込みを共有し、失敗したら次の呼び出しで読み直す', async () => {
    const { explanations, store, target } = await service();
    const loading = deferred<void>();
    const load = vi.spyOn(store, 'load').mockReturnValueOnce(loading.promise);
    const first = explanations.ensureLoaded(target.repo);
    const second = explanations.ensureLoaded(target.repo);
    loading.resolve();
    await Promise.all([first, second]);
    await explanations.ensureLoaded(target.repo);
    expect(load).toHaveBeenCalledOnce();
    const other = '/other';
    load.mockRejectedValueOnce(new Error('索引を読めません'));
    await expect(explanations.ensureLoaded(other)).rejects.toThrow('索引を読めません');
    await explanations.ensureLoaded(other);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('load は他のリポジトリの失敗と読み込み済みの記録を消さない', async () => {
    const { explanations, target, files, store } = await service();
    const other: CommitTarget = { ...target, repo: '/other' };
    // 他のリポジトリの記録と失敗を作る。
    await store.write(other.repo, {
      version: 1,
      comparison: comparisonKey(other),
      agent: 'claude',
      generatedAt: '2026-11-26T00:00:00.000Z',
      promptVersion: 1,
      files: [{ status: 'M', path: 'changed.ts', markdown: '# 解説' }],
    });
    explanations.explanation(other, 'changed.ts');
    await vi.waitFor(() => expect(explanations.explained(other, 'changed.ts')).toBe(true));
    await explanations.generate(other, files);
    expect(explanations.failure(other)).toBeDefined();
    const read = vi.spyOn(store, 'read');
    await explanations.load(target.repo);
    expect(explanations.failure(other)).toBeDefined();
    expect(explanations.explanation(other, 'changed.ts').record).toMatchObject({ kind: 'found' });
    expect(read).not.toHaveBeenCalled();
  });

  it('load は失敗の記録も破棄する', async () => {
    const run = vi.fn<Run>(() => Promise.reject(new AgentCliError('exit', 'claude が終了コード 1 で失敗しました')));
    const { explanations, target, files } = await service({ run });
    await explanations.generate(target, files);
    expect(explanations.failure(target)).toBe('claude が終了コード 1 で失敗しました');
    await explanations.load(target.repo);
    expect(explanations.failure(target)).toBeUndefined();
    expect(explanations.explanation(target, 'changed.ts').failure).toBeUndefined();
  });

  it('記録の読み込み中に load したら、無効になった読み込みの失敗を通知しない', async () => {
    const { explanations, target, files, store } = await service();
    await explanations.generate(target, files);
    const reading = deferred<Awaited<ReturnType<typeof store.read>>>();
    vi.spyOn(store, 'read').mockReturnValueOnce(reading.promise);
    expect(explanations.explanation(target, 'changed.ts').record).toEqual({ kind: 'loading' });
    await explanations.load(target.repo);
    reading.reject(new Error('stale read failed'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
  it.each(['load', 'dispose'] as const)('記録の読み込み中に %s したら、古い結果を入れず通知しない', async (how) => {
    const { explanations, target, files, store } = await service();
    await explanations.generate(target, files);
    const reading = deferred<Awaited<ReturnType<typeof store.read>>>();
    const read = vi.spyOn(store, 'read').mockReturnValueOnce(reading.promise);
    expect(explanations.explanation(target, 'changed.ts').record).toEqual({ kind: 'loading' });
    const changed = vi.fn();
    if (how === 'load') {
      await explanations.load(target.repo);
    } else {
      explanations.dispose();
    }
    explanations.onDidChange(changed);
    reading.resolve({ kind: 'unreadable' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(changed).not.toHaveBeenCalled();
    if (how === 'load') {
      // 古い結果ではなく、読み直した記録を返す。
      read.mockRestore();
      explanations.explanation(target, 'changed.ts');
      await vi.waitFor(() => expect(explanations.explained(target, 'changed.ts')).toBe(true));
    } else {
      expect(explanations.explanation(target, 'changed.ts').record).toEqual({ kind: 'loading' });
    }
  });

  it('has は保存済みの解説がある比較だけ true を返す', async () => {
    const { explanations, target, files } = await service();
    expect(explanations.has(target)).toBe(false);
    await explanations.generate(target, files);
    expect(explanations.has(target)).toBe(true);
    expect(explanations.has({ ...target, parent: target.commit.hash })).toBe(false);
  });

  it('load は保存済みの比較を読み込み、変更を通知する', async () => {
    const { explanations, store, target } = await service();
    const load = vi.spyOn(store, 'load');
    const changed = vi.fn();
    explanations.onDidChange(changed);
    await explanations.load(target.repo);
    expect(load).toHaveBeenCalledWith(target.repo);
    expect(changed).toHaveBeenCalledOnce();
  });
});

describe('explanationTargetLabel', () => {
  const commit = { hash: 'a'.repeat(40), parents: [], subject: '', author: '', date: '', message: '' };
  it.each([
    [{ repo: '/repo', commit, parent: 'b'.repeat(40) }, 'aaaaaaaa'],
    [
      {
        repo: '/repo',
        commit,
        parent: 'b'.repeat(40),
        pullRequest: { number: 12, headRefOid: 'a'.repeat(40), mergeBase: 'b'.repeat(40) },
      },
      'PR #12',
    ],
    [
      { repo: '/repo', commit, parent: 'b'.repeat(40), uncommitted: { kind: 'staged', createdAt: '' } },
      '未コミットの変更（ステージ済み）',
    ],
  ] as [CommitTarget, string][])('%j は %s', (target, label) => {
    expect(explanationTargetLabel(target)).toBe(label);
  });
});

describe('isBinaryPatch', () => {
  it.each([
    ['Binary files a/x and b/x differ\n', true],
    ['GIT binary patch\r\nliteral 3\r\n', true],
    ['diff --git a/x b/x\nindex 1..2\nBinary files a/x and b/x differ\n', true],
    ['diff --git a/x b/x\nGIT binary patch\nliteral 3\n', true],
    ['diff --git a/x b/x\r\nBinary files a/x and b/x differ\r\n', true],
    ['diff --git a/x b/x\n@@ -1 +1 @@\n-Binary files a/x and b/x differ\n+Binary files a/y and b/y differ\n', false],
    ['@@ -1 +1 @@\r\n-a\r\n+b\r\n', false],
    ['+a\u2028Binary files a/x and b/x differ\n', false],
    ['+b\u2029GIT binary patch\n', false],
    ['+c\rBinary files a/x and b/x differ\n', false],
    ['', false],
  ])('%j はバイナリ: %s', (patch, expected) => {
    expect(isBinaryPatch(patch)).toBe(expected);
  });
});
