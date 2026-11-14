import type { ReviewComment } from './model';
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
    return '日時不明';
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

export function escapeIcons(text: string): string {
  return text.replaceAll('$(', '\\$(');
}

// PR の表示とエクスポートで同じ制御文字・書式文字を扱う。
export function replaceDisplayControls(value: string, replacement: (char: string) => string = () => ''): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, replacement);
}
