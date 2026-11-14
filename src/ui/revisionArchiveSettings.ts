import {
  ARCHIVE_LINK_PATHS_DEFAULT,
  ARCHIVE_MAX_COUNT_DEFAULT,
  ARCHIVE_MAX_COUNT_MINIMUM,
  ARCHIVE_MAX_COUNT_MAXIMUM,
  archiveLinkPaths,
} from '../core/revisionArchive';
import { vsreviewConfiguration } from './configuration';
export function archiveLinkPathsSetting(): string[] {
  // 実行環境を選ぶリンクなので、リポジトリにある設定値は採用しない。
  const setting = vsreviewConfiguration().inspect<unknown>('revisionArchive.linkPaths');
  return archiveLinkPaths(setting?.globalValue ?? ARCHIVE_LINK_PATHS_DEFAULT);
}
export function archiveMaxCountSetting(): number {
  const setting = vsreviewConfiguration().inspect<unknown>('revisionArchive.maxCount');
  const value = setting?.globalValue;
  // 保存数はディスク使用量を制限する値なので、範囲外の整数は近い境界に丸める。
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(ARCHIVE_MAX_COUNT_MAXIMUM, Math.max(ARCHIVE_MAX_COUNT_MINIMUM, value))
    : ARCHIVE_MAX_COUNT_DEFAULT;
}
