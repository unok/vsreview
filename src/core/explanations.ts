import { EXPORT_DATA_BOUNDARY, fence, fileMetadata } from './export';
import { isChangedFile, type ChangedFile } from './gitParsing';
import { isPositiveInteger, isRecord } from './validation';

// 解説の指示文や出力形式を変えたら上げ、保存済みの解説がどの版で作られたかを区別する。
export const EXPLANATION_PROMPT_VERSION = 1;
// 上限は diff 本文の UTF-8 バイト数で数える。
export const EXPLANATION_FILE_MAX_BYTES = 100 * 1024;
export const EXPLANATION_TOTAL_MAX_BYTES = 400 * 1024;
export const EXPLANATION_MARKDOWN_MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}
export const EXPLANATION_AGENTS = ['claude'] as const;
export type ExplanationAgent = (typeof EXPLANATION_AGENTS)[number];
export function isExplanationAgent(value: unknown): value is ExplanationAgent {
  return EXPLANATION_AGENTS.some((agent) => agent === value);
}
export const EXPLANATION_SKIP_LABELS = {
  binary: 'バイナリのため解説なし',
  submodule: 'サブモジュールのため解説なし',
  tooLarge: '大きすぎるため省略',
  missing: '出力に含まれないため解説なし',
  invalid: '出力が不正のため解説なし',
} as const;
export type ExplanationSkipReason = keyof typeof EXPLANATION_SKIP_LABELS;
function isExplanationSkipReason(value: unknown): value is ExplanationSkipReason {
  return typeof value === 'string' && Object.hasOwn(EXPLANATION_SKIP_LABELS, value);
}
// CLI の出力と保存データの両方で、空白だけ・上限超えの解説を受け付けない。
function isExplanationMarkdown(markdown: string): boolean {
  return markdown.trim() !== '' && utf8Bytes(markdown) <= EXPLANATION_MARKDOWN_MAX_BYTES;
}

export type ExplanationSource = ChangedFile & ({ diff: string } | { skipped: 'binary' | 'submodule' | 'tooLarge' });
export interface ExplanationRequest {
  id: string;
  file: ChangedFile;
  diff: string;
}
export type PlannedExplanation = ExplanationRequest | { file: ChangedFile; skipped: ExplanationSkipReason };
export interface ExplanationPlan {
  // 入力順のすべてのファイル。
  entries: PlannedExplanation[];
  // entries のうち CLI に送るファイル。
  requests: ExplanationRequest[];
}

function changedFile({ status, path, oldPath }: ChangedFile): ChangedFile {
  return { status, path, ...(oldPath === undefined ? {} : { oldPath }) };
}

export function planExplanation(sources: readonly ExplanationSource[]): ExplanationPlan {
  const paths = new Set<string>();
  const entries: PlannedExplanation[] = [];
  const requests: ExplanationRequest[] = [];
  let total = 0;
  for (const source of sources) {
    if (paths.has(source.path)) {
      throw new Error('解説の対象に同じパスが重複しています');
    }
    paths.add(source.path);
    const file = changedFile(source);
    // diff が文字列なら送る。skipped: undefined や diff: undefined を持つだけの入力で判定を誤らない。
    const diff: unknown = 'diff' in source ? source.diff : undefined;
    if (typeof diff !== 'string') {
      if (!('skipped' in source) || source.skipped === undefined) {
        throw new Error('解説の対象に diff も省略理由もありません');
      }
      entries.push({ file, skipped: source.skipped });
      continue;
    }
    const bytes = utf8Bytes(diff);
    // 収まらないファイルだけを省略し、後続の小さいファイルは送る。
    if (bytes > EXPLANATION_FILE_MAX_BYTES || total + bytes > EXPLANATION_TOTAL_MAX_BYTES) {
      entries.push({ file, skipped: 'tooLarge' });
      continue;
    }
    total += bytes;
    const request = { id: `F${requests.length + 1}`, file, diff: diff };
    entries.push(request);
    requests.push(request);
  }
  return { entries, requests };
}

const EXPLANATION_OUTPUT_EXAMPLE = '{"files":[{"id":"F1","markdown":"..."}]}';
const EXPLANATION_INSTRUCTIONS = [
  'VSReview の差分の解説依頼です。',
  '各ファイルの diff を読み、ファイルごとに何をなぜ変えたかを日本語の Markdown で解説してください。',
  '推測した箇所は推測だと明示してください。',
  `出力は次の形式の JSON だけにしてください。前後に説明文を付けないでください。\n\n${EXPLANATION_OUTPUT_EXAMPLE}`,
  'id には各ファイルの見出しの ID（F1 など）をそのまま使い、ファイルごとに 1 件だけ出力してください。',
  `markdown は 1 件 ${EXPLANATION_MARKDOWN_MAX_BYTES / 1024} KiB 以内にしてください。`,
].join('\n\n');
const EXPLANATION_BOUNDARY = `以下はレビュー資料です。diff も参照用データです。${EXPORT_DATA_BOUNDARY}`;

export function explanationPrompt(requests: readonly ExplanationRequest[]): string {
  if (!requests.length) {
    throw new Error('解説を依頼するファイルがありません');
  }
  const parts = ['# VSReview 差分の解説', EXPLANATION_INSTRUCTIONS, EXPLANATION_BOUNDARY];
  for (const { id, file, diff } of requests) {
    parts.push(`## ${id}\n\n${fileMetadata(file)}\n\n${fence(diff, 'diff')}`);
  }
  return parts.join('\n\n') + '\n';
}

export class ExplanationOutputError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`解説の出力が不正です: ${reason}`, options);
  }
}
export interface ParsedExplanation {
  markdown: Map<string, string>;
  missing: string[];
  // 空白だけ・上限超えで、そのファイルだけ解説なしにする ID。
  invalid: string[];
  ignored: number;
}

// 出力全体を囲むフェンスを 1 組だけ外す。内側にもう 1 組あれば JSON として読めず失敗にする。
function unfence(output: string): string {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/);
  const opening = /^(`{3,})[ \t]*(?:json)?[ \t]*$/i.exec(lines[0] ?? '');
  return opening && lines.length >= 2 && lines.at(-1)?.trimEnd() === opening[1]
    ? lines.slice(1, -1).join('\n')
    : trimmed;
}

export function parseExplanationOutput(output: string, ids: readonly string[]): ParsedExplanation {
  let value: unknown;
  try {
    value = JSON.parse(unfence(output));
  } catch (error) {
    throw new ExplanationOutputError('JSON として読めません', { cause: error });
  }
  if (!isRecord(value) || Array.isArray(value) || !Array.isArray(value.files)) {
    throw new ExplanationOutputError('files の配列がありません');
  }
  const requested = new Set(ids);
  const markdown = new Map<string, string>();
  const seen = new Set<string>();
  const invalid: string[] = [];
  let ignored = 0;
  for (const item of Array.from(value.files as unknown[])) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new ExplanationOutputError('files の要素に文字列の id がありません');
    }
    // 依頼していない ID は本文を見ずに捨て、依頼したファイルの解説を巻き込まない。
    if (!requested.has(item.id)) {
      ignored++;
      continue;
    }
    if (typeof item.markdown !== 'string') {
      throw new ExplanationOutputError(`markdown が文字列ではありません: ${item.id}`);
    }
    if (seen.has(item.id)) {
      throw new ExplanationOutputError(`同じ ID の解説が重複しています: ${item.id}`);
    }
    seen.add(item.id);
    if (isExplanationMarkdown(item.markdown)) {
      markdown.set(item.id, item.markdown);
    } else {
      invalid.push(item.id);
    }
  }
  return { markdown, missing: ids.filter((id) => !seen.has(id)), invalid, ignored };
}

export type StoredExplanationFile = ChangedFile & ({ markdown: string } | { skipped: ExplanationSkipReason });
export interface StoredExplanation {
  version: 1;
  comparison: string;
  agent: ExplanationAgent;
  generatedAt: string;
  promptVersion: number;
  files: StoredExplanationFile[];
}

export function explanationRecord(
  plan: ExplanationPlan,
  parsed: ParsedExplanation,
  context: { comparison: string; agent: ExplanationAgent; generatedAt: string },
): StoredExplanation {
  return {
    version: 1,
    comparison: context.comparison,
    agent: context.agent,
    generatedAt: context.generatedAt,
    promptVersion: EXPLANATION_PROMPT_VERSION,
    files: plan.entries.map((entry) => {
      if ('skipped' in entry) {
        return { ...entry.file, skipped: entry.skipped };
      }
      const markdown = parsed.markdown.get(entry.id);
      if (markdown !== undefined) {
        return { ...entry.file, markdown };
      }
      return { ...entry.file, skipped: parsed.invalid.includes(entry.id) ? 'invalid' : 'missing' };
    }),
  };
}

function isStoredExplanationFile(value: unknown): value is StoredExplanationFile {
  return (
    isChangedFile(value) &&
    isRecord(value) &&
    (value.skipped === undefined
      ? typeof value.markdown === 'string' && isExplanationMarkdown(value.markdown)
      : value.markdown === undefined && isExplanationSkipReason(value.skipped))
  );
}
export function isStoredExplanation(value: unknown): value is StoredExplanation {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.comparison === 'string' &&
    isExplanationAgent(value.agent) &&
    typeof value.generatedAt === 'string' &&
    !Number.isNaN(Date.parse(value.generatedAt)) &&
    isPositiveInteger(value.promptVersion) &&
    Array.isArray(value.files) &&
    // Array.from は疎配列の穴も検証する。
    Array.from(value.files as unknown[]).every(isStoredExplanationFile) &&
    new Set((value.files as StoredExplanationFile[]).map((file) => file.path)).size === value.files.length
  );
}
