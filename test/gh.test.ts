import {
  pullRequest as defaultPullRequest,
  repository,
  temporaryDirectory,
  pullRequestRepository,
  gitProcesses,
} from './fixtures';
import { PULL_REQUEST_FIELDS } from '../src/core/pullRequests';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GhClient, GH_TIMEOUT_MS, type GhExecutor } from '../src/git/gh';
import { preparePullRequest, resolvePullRequestRemote, restorePullRequestComparison } from '../src/git/pullRequests';
import { GitClient, GitError, runGit } from '../src/git/client';
import { commitAll } from './gitFixtures';

describe('gh', () => {
  describe('GitHub CLI', () => {
    it('一覧の引数を組み立てる', async () => {
      const execute = vi.fn<GhExecutor>(() => Promise.resolve(JSON.stringify([defaultPullRequest])));
      expect(await new GhClient('/repo', execute).list(50)).toEqual([defaultPullRequest]);
      expect(execute).toHaveBeenCalledWith('/repo', [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '50',
        '--json',
        PULL_REQUEST_FIELDS,
      ]);
    });
    it('番号指定の引数を組み立てる', async () => {
      const execute = vi.fn<GhExecutor>(() => Promise.resolve(JSON.stringify(defaultPullRequest)));
      expect(await new GhClient('/repo', execute).view(12)).toEqual(defaultPullRequest);
      expect(execute).toHaveBeenCalledWith('/repo', ['pr', 'view', '12', '--json', PULL_REQUEST_FIELDS]);
    });
    it.each(['gh がありません', 'not logged in', 'not a GitHub repository'])(
      '実行失敗の理由を返す: %s',
      async (message) => {
        await expect(new GhClient('/repo', () => Promise.reject(new Error(message))).list(50)).rejects.toThrow(message);
      },
    );
    it('不正な JSON を拒否する', async () => {
      await expect(new GhClient('/repo', () => Promise.resolve('{')).list(50)).rejects.toThrow();
    });
  });
  describe('実 Git での PR 比較', () => {
    it('フォークの refs/pull を取得して merge-base とリネーム・削除差分を復元する', async () => {
      const { directory, git } = await repository();
      await writeFile(join(directory, 'old'), 'old\n');
      await writeFile(join(directory, 'deleted'), 'remove\n');
      await commitAll(directory, 'initial');
      const initial = (await git.head())!;
      await runGit(directory, ['checkout', '-b', 'topic']);
      await runGit(directory, ['mv', 'old', 'renamed']);
      await runGit(directory, ['rm', 'deleted']);
      await commitAll(directory, 'rename');
      const head = (await git.head())!;
      await runGit(directory, ['checkout', 'main']);
      await writeFile(join(directory, 'base-only'), 'base\n');
      await commitAll(directory, 'base advanced');
      const base = (await git.head())!;
      const origin = await temporaryDirectory();
      await runGit(origin, ['init', '--bare']);
      await runGit(directory, ['remote', 'add', 'origin', origin]);
      await runGit(directory, ['push', 'origin', 'main', `${head}:refs/pull/12/head`]);
      const local = await temporaryDirectory();
      await runGit(local, ['init']);
      await runGit(local, ['remote', 'add', 'origin', origin]);
      const pullRequest = { ...defaultPullRequest, baseRefOid: base, headRefOid: head };
      const gh = new GhClient(local, () => Promise.resolve(JSON.stringify(pullRequest)));
      const target = await preparePullRequest(new GitClient(local), await gh.view(12), 'origin');
      expect(target.pullRequest?.isCrossRepository).toBe(true);
      expect(target.parent).toBe(initial);
      expect(target.pullRequest?.number).toBe(12);
      expect(await new GitClient(local).files(target.commit)).toEqual([
        { path: 'deleted', status: 'D' },
        { path: 'renamed', oldPath: 'old', status: 'R' },
      ]);
      expect(await git.head()).toBe(base);
    });
    it('base ブランチの代替 fetch が成功しても指定 base OID がなければ拒否する', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      vi.spyOn(git, 'fetch').mockImplementation(async (remote, ref) => {
        if (ref === 'f'.repeat(40)) {
          throw new GitError(['fetch'], 'not our ref', 128);
        }
        await new GitClient(git.root).fetch(remote, ref);
      });
      await expect(preparePullRequest(git, { ...pullRequest, baseRefOid: 'f'.repeat(40) })).rejects.toThrow(
        'PR のリビジョンが変わりました',
      );
      expect(await git.hasCommit(pullRequest.headRefOid)).toBe(true);
      expect(await git.hasCommit(pullRequest.baseRefOid)).toBe(true);
    });
    it('fetch 失敗時は不完全なオブジェクトで比較しない', async () => {
      const { git, pullRequest, origin } = await pullRequestRepository();
      await runGit(git.root, ['remote', 'set-url', 'origin', join(origin, 'missing')]);
      await expect(preparePullRequest(git, pullRequest)).rejects.toThrow('git fetch:');
    });
  });

  describe('PR のリモート選択', () => {
    it.each([
      'git@github.com:example/repo.git',
      'ssh://git@github.com/example/repo.git',
      'https://github.com/example/repo.git',
      'https://GITHUB.COM/EXAMPLE/REPO.git/',
    ])('gh のリポジトリ URL と %s を照合する', async (url) => {
      const { git, directory } = await repository();
      await runGit(directory, ['remote', 'add', 'origin', 'https://github.com/fork/repo.git']);
      await runGit(directory, ['remote', 'add', 'upstream', url]);
      expect(await resolvePullRequestRemote(git, defaultPullRequest)).toBe('upstream');
      await runGit(directory, ['remote', 'add', 'custom', url]);
      expect(await resolvePullRequestRemote(git, defaultPullRequest, 'custom')).toBe('custom');
    });
  });

  describe('GitHub CLI の実行本体', () => {
    async function executable(script: string) {
      const bin = await temporaryDirectory();
      await writeFile(join(bin, 'gh'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
      vi.stubEnv('PATH', bin);
      vi.resetModules();
      return (await import('../src/git/gh.js')).runGh;
    }
    it('PATH に gh がなければ実行前に理由を返す', async () => {
      vi.stubEnv('PATH', '');
      vi.resetModules();
      const { runGh } = await import('../src/git/gh.js');
      await expect(runGh('/repo', [])).rejects.toThrow('gh 実行ファイルが見つかりません');
    });
    it('shell を使わず引数・cwd・隔離した環境・timeout を子プロセスに渡す', async () => {
      const runGh = await executable(
        `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), repo: process.env.GH_REPO, gitDir: process.env.GIT_DIR, locale: process.env.LC_ALL, prompt: process.env.GH_PROMPT_DISABLED, pager: process.env.GH_PAGER }));`,
      );
      vi.stubEnv('GH_REPO', 'attacker/repo');
      vi.stubEnv('GIT_DIR', '/untrusted');
      const root = await temporaryDirectory();
      const processes = gitProcesses();
      expect(JSON.parse(await runGh(root, ['pr', 'view', '12; echo unsafe']))).toEqual({
        args: ['pr', 'view', '12; echo unsafe'],
        cwd: root,
        locale: 'C',
        prompt: '1',
        pager: 'cat',
      });
      expect(processes.mock.calls[0]?.[2]).toMatchObject({ timeout: GH_TIMEOUT_MS, cwd: root });
      expect(processes.mock.calls[0]?.[2]).not.toHaveProperty('shell');
    });
    it.each([true, false])('実行失敗で stderr の有無 %s に応じた理由を返す', async (stderr) => {
      const runGh = await executable(`${stderr ? "process.stderr.write('not logged in');" : ''}process.exit(1);`);
      await expect(runGh(await temporaryDirectory(), ['pr', 'list'])).rejects.toThrow(
        stderr ? 'not logged in' : 'Command failed',
      );
    });
  });

  describe('PR オブジェクトの復旧と入力境界', () => {
    it('保存比較のオブジェクトがなければ refs/pull と base を再取得し、新しいローカル ref を作らない', async () => {
      const { git, directory, saved, pullRequest } = await pullRequestRepository();
      const gh = new GhClient(directory, () => Promise.resolve(JSON.stringify(pullRequest)));
      await restorePullRequestComparison(git, saved.pullRequest, 'origin', gh);
      expect(await git.hasCommit(saved.commit)).toBe(true);
      expect(await git.hasCommit(saved.parent)).toBe(true);
      expect((await git.files((await preparePullRequest(git, pullRequest)).commit)).map((file) => file.path)).toEqual([
        'file',
      ]);
      expect((await runGit(directory, ['for-each-ref', '--format=%(refname)'])).toString()).toBe('');
    });
    it('オブジェクトがあれば gh と fetch を省く', async () => {
      const { git, directory, pullRequest, saved } = await pullRequestRepository();
      await preparePullRequest(git, pullRequest);
      const execute = vi.fn(() => Promise.reject(new Error('呼び出し禁止')));
      const processes = gitProcesses();
      await restorePullRequestComparison(git, saved.pullRequest, 'origin', new GhClient(directory, execute));
      expect(execute).not.toHaveBeenCalled();
      expect(processes.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('fetch'))).toBe(false);
      expect(await git.hasCommit(saved.commit)).toBe(true);
      expect(await git.hasCommit(saved.parent)).toBe(true);
    });
    it('force push 後に保存 head を取り戻せなければ新しい比較を開かず理由を返す', async () => {
      const { git, directory, pullRequest, source, sourceGit, base } = await pullRequestRepository();
      await runGit(source, ['checkout', '--detach', base]);
      await writeFile(join(source, 'file'), 'force\n');
      await commitAll(source, 'force');
      const latest = (await sourceGit.head())!;
      await runGit(source, ['push', '--force', 'origin', `${latest}:refs/pull/12/head`]);
      await expect(
        restorePullRequestComparison(
          git,
          { number: 12, headRefOid: 'f'.repeat(40), mergeBase: base },
          'origin',
          new GhClient(directory, () => Promise.resolve(JSON.stringify({ ...pullRequest, headRefOid: latest }))),
        ),
      ).rejects.toThrow('保存した PR の head を取得できません: git fetch:');
    });
    it.each(['main:refs/heads/injected', '../main', 'main..bad', 'main.lock', 'main\nnext', '', 'x@{1}'])(
      'base ブランチ名 %j を refspec として使用しない',
      async (baseRefName) => {
        const { git, pullRequest } = await pullRequestRepository();
        class RejectOidGit extends GitClient {
          override fetch(remote: string, ref: string) {
            return ref === pullRequest.baseRefOid
              ? Promise.reject(new GitError(['fetch'], 'not our ref', 128))
              : super.fetch(remote, ref);
          }
        }
        const guarded = new RejectOidGit(git.root);
        const processes = gitProcesses();
        await expect(preparePullRequest(guarded, { ...pullRequest, baseRefName })).rejects.toThrow('ref 名が不正です');
        expect(processes.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('fetch'))).toBe(false);
      },
    );
    it.each(['https://example.com/repo', '/tmp/another-repo', '--upload-pack=unsafe', 'missing'])(
      '未登録の remote %s を拒否する',
      async (remote) => {
        const { git, pullRequest } = await pullRequestRepository();
        await expect(preparePullRequest(git, pullRequest, remote)).rejects.toThrow('取得先リモートがありません');
      },
    );
    it('OID fetch が拒否されても検証済み base ブランチを取得して比較する', async () => {
      const { git, pullRequest, base } = await pullRequestRepository();
      class RejectOidGit extends GitClient {
        override fetch(remote: string, ref: string) {
          return ref === base ? Promise.reject(new GitError(['fetch'], 'not our ref', 128)) : super.fetch(remote, ref);
        }
      }
      const target = await preparePullRequest(new RejectOidGit(git.root), pullRequest);
      expect(target.parent).toBe(base);
      expect(await git.files(target.commit)).toEqual([{ status: 'M', path: 'file' }]);
    });
    it.each(['authentication failed', 'timed out', 'Could not resolve host'])(
      'base fetch の %s では再取得せず元の理由を返す',
      async (message) => {
        const { git, pullRequest } = await pullRequestRepository();
        const fetch = vi.spyOn(git, 'fetch').mockRejectedValue(new Error(message));
        await expect(preparePullRequest(git, pullRequest)).rejects.toThrow(message);
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );
    it('代替取得も失敗したら OID 拒否と代替取得の理由を両方返す', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      vi.spyOn(git, 'fetch')
        .mockRejectedValueOnce(new GitError(['fetch'], 'not our ref', 128))
        .mockRejectedValueOnce(new Error('branch denied'));
      await expect(preparePullRequest(git, pullRequest)).rejects.toThrow(/not our ref.*branch denied/s);
    });
    it('fetch が成功しても要求したオブジェクトが存在しなければ比較しない', async () => {
      const { git, pullRequest } = await pullRequestRepository();
      await expect(preparePullRequest(git, { ...pullRequest, headRefOid: 'f'.repeat(40) })).rejects.toThrow(
        'PR のリビジョンが変わりました',
      );
    });
  });

  describe('PR オブジェクトの取得と検証', () => {
    it('origin がなくても PR の URL と一致する登録済み remote を使う', async () => {
      const { git } = await repository();
      await runGit(git.root, ['remote', 'add', 'upstream', 'git@github.com:example/repo.git']);
      expect(await resolvePullRequestRemote(git, defaultPullRequest)).toBe('upstream');
    });

    it('共通の祖先がない PR に比較不能の理由を返す', async () => {
      const { git, source, sourceGit, pullRequest } = await pullRequestRepository();
      await runGit(source, ['checkout', '--orphan', 'unrelated']);
      await writeFile(join(source, 'file'), 'unrelated');
      await commitAll(source, 'unrelated');
      const head = (await sourceGit.head())!;
      await runGit(source, ['push', '--force', 'origin', `${head}:refs/pull/12/head`]);
      await expect(preparePullRequest(git, { ...pullRequest, headRefOid: head })).rejects.toThrow(
        '共通の祖先がありません',
      );
    });

    it.each([
      ['https://github.com/other/repo/pull/12', false],
      ['https://github.com/example/repo/pull/12', true],
      ['not a URL', false],
    ] as const)('PR URL %s は origin の既定値と一致優先順位に従う', async (url, matching) => {
      const { git } = await repository();
      await runGit(git.root, [
        'remote',
        'add',
        'origin',
        matching ? 'https://github.com/example/repo.git' : 'https://github.com/unrelated/repo.git',
      ]);
      await runGit(git.root, ['remote', 'add', 'upstream', 'https://github.com/example/repo.git']);
      expect(await resolvePullRequestRemote(git, { url })).toBe('origin');
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
      'gh の件数と番号 %s を実行前に拒否する',
      async (value) => {
        const execute = vi.fn<GhExecutor>(() => Promise.resolve('[]'));
        const gh = new GhClient('/repo', execute);
        await expect(gh.list(value)).rejects.toThrow('正の整数');
        await expect(gh.view(value)).rejects.toThrow('正の整数');
        await expect(gh.viewOpenHead(value)).rejects.toThrow('正の整数');
        expect(execute).not.toHaveBeenCalled();
      },
    );
    it.each([1, Number.MAX_SAFE_INTEGER])('gh の件数 %s は安全な正の整数として受け付ける', async (limit) => {
      const execute = vi.fn<GhExecutor>(() => Promise.resolve('[]'));
      expect(await new GhClient('/repo', execute).list(limit)).toEqual([]);
      expect(execute.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--limit', String(limit)]));
    });

    describe('保存 PR の旧 head 復元', () => {
      it('force push 後も refs/pull に残らない保存 head を OID で取り戻す', async () => {
        const { git, directory, source, sourceGit, saved, pullRequest, base } = await pullRequestRepository();
        await runGit(source, ['checkout', '--detach', base]);
        await writeFile(join(source, 'file'), 'replacement');
        await commitAll(source, 'force');
        const latest = (await sourceGit.head())!;
        await runGit(source, ['push', '--force', 'origin', `${latest}:refs/pull/12/head`]);
        await restorePullRequestComparison(
          git,
          saved.pullRequest,
          'origin',
          new GhClient(directory, () => Promise.resolve(JSON.stringify({ ...pullRequest, headRefOid: latest }))),
        );
        expect((await git.content(saved.commit, 'file')).text).toBe('head\n');
        expect(await git.mergeBase(saved.parent, saved.commit)).toBe(base);
      });
      it('head が取得できても保存 merge-base がなければ復元を中止する', async () => {
        const { git, directory, pullRequest, saved } = await pullRequestRepository();
        await expect(
          restorePullRequestComparison(
            git,
            { ...saved.pullRequest, mergeBase: 'f'.repeat(40) },
            'origin',
            new GhClient(directory, () => Promise.resolve(JSON.stringify(pullRequest))),
          ),
        ).rejects.toThrow('保存した PR の merge-base を取得できません');
        expect(await git.hasCommit(saved.commit)).toBe(true);
      });
    });
  });

  describe('保存比較の復元失敗', () => {
    it('URL を持つ保存比較は gh が使えなくても復元する', async () => {
      const { git, saved } = await pullRequestRepository();
      const execute = vi.fn(() => Promise.reject(new Error('gh unavailable')));
      await restorePullRequestComparison(
        git,
        saved.pullRequest,
        'origin',
        new GhClient(git.root, execute),
        saved.pullRequest,
      );
      expect(await git.hasCommit(saved.commit)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });
    it('URL がなく gh も失敗したら理由を返す', async () => {
      const { git, saved } = await pullRequestRepository();
      await expect(
        restorePullRequestComparison(
          git,
          saved.pullRequest,
          'origin',
          new GhClient(git.root, () => Promise.reject(new Error('gh offline'))),
        ),
      ).rejects.toThrow('gh offline');
    });
    it('refs/pull が取得不能でも保存 OID から復元する', async () => {
      const { git, saved } = await pullRequestRepository();
      class OidOnlyGit extends GitClient {
        override fetch(remote: string, ref: string) {
          return ref.startsWith('refs/pull/') ? Promise.reject(new Error('PR ref missing')) : super.fetch(remote, ref);
        }
      }
      const restored = new OidOnlyGit(git.root);
      await restorePullRequestComparison(
        restored,
        saved.pullRequest,
        'origin',
        new GhClient(git.root, () => Promise.reject(new Error('gh 禁止'))),
        saved.pullRequest,
      );
      expect((await restored.content(saved.commit, 'file')).text).toBe('head\n');
    });
    it.each(['OPEN', 'CLOSED'] as const)('未完了 head の引数と %s 応答を検証する', async (state) => {
      const execute = vi.fn<GhExecutor>(() =>
        Promise.resolve(JSON.stringify({ state, headRefOid: defaultPullRequest.headRefOid })),
      );
      expect(await new GhClient('/repo', execute).viewOpenHead(12)).toBe(
        state === 'OPEN' ? defaultPullRequest.headRefOid : undefined,
      );
      expect(execute).toHaveBeenCalledWith('/repo', ['pr', 'view', '12', '--json', 'headRefOid,state']);
    });
  });
});
