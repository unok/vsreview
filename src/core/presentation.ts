import type { ReviewComment } from './model';
import type { UncommittedKind } from './uncommitted';
export const UNCOMMITTED_LABEL = '未コミットの変更';
export const UNCOMMITTED_CHANGED_LABEL = '内容が変更済み';
const UNKNOWN_DATE_LABEL = '日時不明';
export const UNCOMMITTED_KIND_LABELS = { staged: 'ステージ済み', unstaged: '未ステージ' };
export function uncommittedLabel(kind: UncommittedKind): string {
  return `${UNCOMMITTED_LABEL}（${UNCOMMITTED_KIND_LABELS[kind]}）`;
}
const SHORT_HASH_LENGTH = 8;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * 60;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * 24;
export function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH);
}
export function locationLabel(comment: Pick<ReviewComment, 'side' | 'startLine' | 'endLine'>): string {
  return comment.side === 'file' ? 'ファイル全体' : `${comment.side} L${comment.startLine}-L${comment.endLine}`;
}
export function resolvedLabel(resolved: boolean): string {
  return resolved ? '解決済み' : '未解決';
}
export function relativeDate(date: string, now = Date.now()): string {
  if (!Number.isFinite(Date.parse(date))) {
    return UNKNOWN_DATE_LABEL;
  }
  const seconds = Math.max(0, (now - Date.parse(date)) / MILLISECONDS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) {
    return 'たった今';
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}分前`;
  }
  if (seconds < SECONDS_PER_DAY) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}時間前`;
  }
  return `${Math.floor(seconds / SECONDS_PER_DAY)}日前`;
}

export function commentCountLabel(count: number): string {
  // ツリーの description に「0 コメント」を出さないため、0 件は空文字を返す。
  // 呼び出し側は filter(Boolean) で除くか、そのまま空の description にする。
  return count === 0 ? '' : `${count} コメント`;
}
export function rewrittenSuffix(rewritten: boolean): string {
  return rewritten ? ' · 書き換え済み' : '';
}
export function uncommittedChangedSuffix(changed: boolean): string {
  return changed ? ` · ${UNCOMMITTED_CHANGED_LABEL}` : '';
}
export function snapshotDateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return UNKNOWN_DATE_LABEL;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function commentExcerpt(comment: Pick<ReviewComment, 'excerpt' | 'hunkHeader' | 'code'>): string {
  return comment.excerpt || `${comment.hunkHeader}\n${comment.code}`;
}

export function escapeIcons(text: string): string {
  return text.replaceAll('$(', '\\$(');
}

// PR の表示とエクスポートで同じ制御文字・書式文字を扱う。
export function replaceDisplayControls(value: string, replacement: (char: string) => string = () => ''): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, replacement);
}
