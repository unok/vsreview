import { describe, expect, it, vi } from 'vitest';
import { RevisionArchivePermissions, archivePermissionKey } from '../src/ui/revisionArchivePermissions';
import { KeyedState } from './fixtures';
import { warning } from './vscodeMock';

describe('revisionArchivePermissions', () => {
  it('リセット中の要求は古い保存済み許可を使わず、削除後に再確認する', async () => {
    const state = new KeyedState();
    await state.update(archivePermissionKey('/repo'), true);
    const permissions = new RevisionArchivePermissions(state);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = state.update.bind(state);
    vi.spyOn(state, 'update').mockImplementationOnce(async (key, value) => {
      await gate;
      await update(key, value);
    });
    const reset = permissions.reset();
    warning.mockResolvedValue('拒否');
    const allowed = permissions.allowed('/repo');
    await Promise.resolve();
    expect(warning).not.toHaveBeenCalled();
    release();
    await reset;
    expect(await allowed).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
  });
  it('外部 PR の許可を head ごとに確認する', async () => {
    const permissions = new RevisionArchivePermissions(new KeyedState());
    warning.mockResolvedValue('許可');
    expect(await permissions.allowed('/repo', { number: 12, head: 'a'.repeat(40) })).toBe(true);
    expect(await permissions.allowed('/repo', { number: 12, head: 'a'.repeat(40) })).toBe(true);
    warning.mockResolvedValue('拒否');
    expect(await permissions.allowed('/repo', { number: 12, head: 'b'.repeat(40) })).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
  });
  it('確認中のリセット後は回答を保存せず再確認する', async () => {
    const state = new KeyedState();
    const permissions = new RevisionArchivePermissions(state);
    let answer!: (value: string) => void;
    warning.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = permissions.allowed('/repo');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await permissions.reset();
    answer('許可');
    expect(await pending).toBe(false);
    expect(state.get(archivePermissionKey('/repo'))).toBeUndefined();
    warning.mockResolvedValue('許可');
    expect(await permissions.allowed('/repo')).toBe(true);
    expect(warning).toHaveBeenCalledTimes(2);
  });
  it('保存済みの値も再読取し、キャッシュに残さない', async () => {
    const state = new KeyedState();
    const permissions = new RevisionArchivePermissions(state);
    await state.update(archivePermissionKey('/repo'), true);
    expect(await permissions.allowed('/repo')).toBe(true);
    await state.update(archivePermissionKey('/repo'), false);
    expect(await permissions.allowed('/repo')).toBe(false);
    expect(warning).not.toHaveBeenCalled();
  });
  it('同時の確認を共有し、閉じた場合は次の要求で再確認する', async () => {
    const state = new KeyedState();
    const permissions = new RevisionArchivePermissions(state);
    warning.mockResolvedValue(undefined);
    expect(await Promise.all([permissions.allowed('/repo'), permissions.allowed('/repo')])).toEqual([false, false]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(state.get(archivePermissionKey('/repo'))).toBeUndefined();
    warning.mockResolvedValue('許可');
    expect(await permissions.allowed('/repo')).toBe(true);
    expect(warning).toHaveBeenCalledTimes(2);
  });
  it('リセットは許可と拒否だけを消し、比較とコメントを保つ', async () => {
    const state = new KeyedState();
    await state.update(archivePermissionKey('/repo'), true);
    await state.update(archivePermissionKey('/repo', { number: 12, head: 'a'.repeat(40) }), false);
    await state.update('vsreview.archiveContexts', ['saved']);
    await state.update('vsreview.comments', 'comments');
    await new RevisionArchivePermissions(state).reset();
    expect(state.keys().sort()).toEqual(['vsreview.archiveContexts', 'vsreview.comments']);
    expect(state.get('vsreview.archiveContexts')).toEqual(['saved']);
    expect(state.get('vsreview.comments')).toBe('comments');
  });
});
