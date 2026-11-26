import manifest from '../package.json';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import * as explanations from '../src/core/explanations';
import * as configuration from '../src/ui/configuration';
import { EXPLANATION_AGENT_DEFAULT, explanationAgentSetting } from '../src/ui/explanationSettings';
import { globalConfiguration, workspaceConfiguration, workspaceFolderConfiguration } from './vscodeMock';
import './fixtures';

// 選べる値も既定値も claude だけなので、どの値を読んだかを区別できるよう、設定の各層と型ガードを差し替える。
function stubInspect(values: {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}): void {
  vi.spyOn(explanations, 'isExplanationAgent').mockImplementation((value): value is explanations.ExplanationAgent =>
    ['claude', 'other', 'unused'].includes(value as string),
  );
  vi.spyOn(configuration, 'vsreviewConfiguration').mockReturnValue({
    get: () => 'unused',
    inspect: () => ({ key: 'vsreview.explanation.agent', defaultValue: 'unused', ...values }),
  } as unknown as vscode.WorkspaceConfiguration);
}

describe('explanationSettings', () => {
  it('マニフェストは claude だけを選べ、既定値とスコープが実装と一致する', () => {
    const property = manifest.contributes.configuration.properties['vsreview.explanation.agent'];
    expect(property).toMatchObject({ enum: ['claude'], default: 'claude', scope: 'machine' });
    expect(EXPLANATION_AGENT_DEFAULT).toBe('claude');
  });
  it.each([
    ['未設定', undefined],
    ['claude', 'claude'],
    ['未対応のエージェント', 'codex'],
    ['大文字違い', 'Claude'],
    ['空文字列', ''],
    ['文字列でない', ['claude']],
  ])('ユーザー設定が %s なら claude を使う', (_, value) => {
    globalConfiguration.set('vsreview.explanation.agent', value);
    expect(explanationAgentSetting()).toBe('claude');
  });
  it('ワークスペースとフォルダの値は使わない', () => {
    workspaceConfiguration.set('vsreview.explanation.agent', 'codex');
    workspaceFolderConfiguration.set('/repo', new Map([['vsreview.explanation.agent', 'agy']]));
    expect(explanationAgentSetting()).toBe('claude');
  });
  it('有効な値が増えても、ユーザー設定の値だけを採用する', () => {
    stubInspect({ globalValue: 'other' });
    expect(explanationAgentSetting()).toBe('other');
  });
  it('ユーザー設定が不正なら、ワークスペース・フォルダ・既定の有効な値を使わず既定の claude に落とす', () => {
    stubInspect({ globalValue: 'codex', workspaceValue: 'unused', workspaceFolderValue: 'unused' });
    expect(explanationAgentSetting()).toBe('claude');
  });
});
