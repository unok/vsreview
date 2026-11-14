import manifest from '../package.json';
import { ARCHIVE_LINK_PATHS_DEFAULT } from '../src/core/revisionArchive';
import { describe, expect, it } from 'vitest';
import { archiveLinkPathsSetting, archiveMaxCountSetting } from '../src/ui/revisionArchiveSettings';
import { globalConfiguration, workspaceConfiguration, workspaceFolderConfiguration } from './vscodeMock';
import './fixtures';

describe('revisionArchiveSettings', () => {
  it('マニフェストと実装のリンク既定値が一致する', () => {
    expect(manifest.contributes.configuration.properties['vsreview.revisionArchive.linkPaths'].default).toEqual(
      ARCHIVE_LINK_PATHS_DEFAULT,
    );
  });
  it('リンクの既定値は直下を含むパターンで、空配列もユーザー設定から読む', () => {
    workspaceConfiguration.set('vsreview.revisionArchive.linkPaths', ['workspace']);
    expect(archiveLinkPathsSetting()).toEqual(['**/node_modules']);
    globalConfiguration.set('vsreview.revisionArchive.linkPaths', []);
    expect(archiveLinkPathsSetting()).toEqual([]);
    globalConfiguration.set('vsreview.revisionArchive.linkPaths', ['**/deps', 'vendor']);
    expect(archiveLinkPathsSetting()).toEqual(['**/deps', 'vendor']);
  });
  it.each([
    [undefined, 10],
    [NaN, 10],
    [Infinity, 10],
    [2.5, 10],
    ['50', 10],
    [null, 10],
    [-100, 2],
    [-1, 2],
    [0, 2],
    [1, 2],
    [2, 2],
    [50, 50],
    [51, 50],
    [1000000, 50],
  ])('ユーザー設定 %j を %i 件として読む', (value, expected) => {
    globalConfiguration.set('vsreview.revisionArchive.maxCount', value);
    expect(archiveMaxCountSetting()).toBe(expected);
  });
  it('ワークスペースの値は使わない', () => {
    workspaceConfiguration.set('vsreview.revisionArchive.maxCount', 1000000);
    workspaceFolderConfiguration.set('/repo', new Map([['vsreview.revisionArchive.maxCount', 2]]));
    expect(archiveMaxCountSetting()).toBe(10);
    globalConfiguration.set('vsreview.revisionArchive.maxCount', 20);
    expect(archiveMaxCountSetting()).toBe(20);
  });
});
