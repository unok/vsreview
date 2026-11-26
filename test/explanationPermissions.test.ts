import { describe, expect, it } from 'vitest';
import { ExplanationPermissions, explanationPermissionKey } from '../src/ui/explanationPermissions';
import { RevisionArchivePermissions, archivePermissionKey } from '../src/ui/revisionArchivePermissions';
import { KeyedState } from './fixtures';
import { warning } from './vscodeMock';

describe('explanationPermissions', () => {
  it('外部の LLM サービスへの送信を確認し、許可を保存する', async () => {
    const state = new KeyedState();
    warning.mockResolvedValue('送信を許可');
    expect(await new ExplanationPermissions(state).allowed('/repo', 'claude')).toBe(true);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /\/repo .*外部の LLM サービス（claude）へ送ります。.*ワークスペースに保存され、リセットできます/,
      ),
      { modal: true },
      '送信を許可',
      '拒否',
    );
    expect(state.get(explanationPermissionKey('/repo', 'claude'))).toBe(true);
    expect(await new ExplanationPermissions(state).allowed('/repo', 'claude')).toBe(true);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('拒否を記憶し、次の要求では確認しない', async () => {
    const state = new KeyedState();
    const permissions = new ExplanationPermissions(state);
    warning.mockResolvedValue('拒否');
    expect(await permissions.allowed('/repo', 'claude')).toBe(false);
    expect(await permissions.allowed('/repo', 'claude')).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(state.get(explanationPermissionKey('/repo', 'claude'))).toBe(false);
  });
  it('閉じたら記録せず、同時の確認は 1 回にまとめる', async () => {
    const state = new KeyedState();
    const permissions = new ExplanationPermissions(state);
    warning.mockResolvedValue(undefined);
    expect(await Promise.all([permissions.allowed('/repo', 'claude'), permissions.allowed('/repo', 'claude')])).toEqual(
      [false, false],
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(state.keys()).toEqual([]);
  });
  it('リポジトリ × エージェントごとに独立し、キーに両方を含める', async () => {
    const state = new KeyedState();
    const permissions = new ExplanationPermissions(state);
    warning.mockResolvedValueOnce('送信を許可').mockResolvedValueOnce('拒否');
    expect(await permissions.allowed('/repo', 'claude')).toBe(true);
    expect(await permissions.allowed('/other', 'claude')).toBe(false);
    expect(explanationPermissionKey('/repo', 'claude')).not.toBe(explanationPermissionKey('/other', 'claude'));
    expect(explanationPermissionKey('/repo', 'claude')).toMatch(
      /^vsreview\.explanationPermission\.[a-f0-9]{64}\.claude$/,
    );
  });
  it('展開の許可と混ざらず、リセットはそれぞれの許可だけを消す', async () => {
    const state = new KeyedState();
    await state.update(archivePermissionKey('/repo'), true);
    await state.update('vsreview.comments', 'comments');
    const explanations = new ExplanationPermissions(state);
    // 展開を許可していても、解説の送信は別に確認する。
    warning.mockResolvedValue('拒否');
    expect(await explanations.allowed('/repo', 'claude')).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(await new RevisionArchivePermissions(state).allowed('/repo')).toBe(true);
    await explanations.reset();
    expect(state.keys().sort()).toEqual([archivePermissionKey('/repo'), 'vsreview.comments'].sort());
    await state.update(explanationPermissionKey('/repo', 'claude'), true);
    await new RevisionArchivePermissions(state).reset();
    expect(state.keys().sort()).toEqual([explanationPermissionKey('/repo', 'claude'), 'vsreview.comments'].sort());
  });
  it('リセット後は再確認する', async () => {
    const state = new KeyedState();
    const permissions = new ExplanationPermissions(state);
    warning.mockResolvedValue('送信を許可');
    expect(await permissions.allowed('/repo', 'claude')).toBe(true);
    await permissions.reset();
    expect(state.keys()).toEqual([]);
    warning.mockResolvedValue('拒否');
    expect(await permissions.allowed('/repo', 'claude')).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
  });
  it('展開の許可の保存キーは変わらない', () => {
    expect(archivePermissionKey('/repo')).toMatch(/^vsreview\.archivePermission\.[a-f0-9]{64}$/);
    expect(archivePermissionKey('/repo', { number: 12, head: 'a'.repeat(40) })).toMatch(
      /^vsreview\.archivePermission\.[a-f0-9]{64}\.pr\.12\.a{40}$/,
    );
  });
});
