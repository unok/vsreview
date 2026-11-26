import { describe, expect, it } from 'vitest';
import {
  EXPLANATION_FILE_MAX_BYTES,
  EXPLANATION_MARKDOWN_MAX_BYTES,
  EXPLANATION_PROMPT_VERSION,
  EXPLANATION_SKIP_LABELS,
  EXPLANATION_TOTAL_MAX_BYTES,
  ExplanationOutputError,
  explanationPrompt,
  explanationRecord,
  isStoredExplanation,
  parseExplanationOutput,
  planExplanation,
  type ExplanationSource,
} from '../src/core/explanations';
import { EXPORT_DATA_BOUNDARY } from '../src/core/export';

const diff = (bytes: number): string => 'a'.repeat(bytes);
const source = (path: string, text = 'diff --git a/x b/x\n+x', extra: Partial<ExplanationSource> = {}) =>
  ({ status: 'M', path, diff: text, ...extra }) as ExplanationSource;
const output = (files: unknown): string => JSON.stringify({ files });

describe('planExplanation', () => {
  it('送るファイルだけに入力順で F1… を振り、バイナリとサブモジュールは理由付きで外す', () => {
    const plan = planExplanation([
      { status: 'M', path: 'image.png', skipped: 'binary' },
      source('a.ts'),
      { status: 'M', path: 'vendor/lib', skipped: 'submodule' },
      source('new.ts', 'rename', { status: 'R', oldPath: 'old.ts' }),
      source('gone.ts', 'deleted', { status: 'D' }),
    ]);
    expect(plan.entries.map((entry) => ('id' in entry ? entry.id : entry.skipped))).toEqual([
      'binary',
      'F1',
      'submodule',
      'F2',
      'F3',
    ]);
    expect(plan.requests.map(({ id, file }) => [id, file.path, file.oldPath])).toEqual([
      ['F1', 'a.ts', undefined],
      ['F2', 'new.ts', 'old.ts'],
      ['F3', 'gone.ts', undefined],
    ]);
  });

  it('skipped が undefined でも diff があれば送る', () => {
    const plan = planExplanation([{ status: 'M', path: 'a.ts', diff: '+x', skipped: undefined } as never]);
    expect(plan.requests.map((request) => request.file.path)).toEqual(['a.ts']);
  });
  it('diff が undefined の省略ファイルは送らず、理由を保つ', () => {
    const plan = planExplanation([{ status: 'M', path: 'image.png', skipped: 'binary', diff: undefined } as never]);
    expect(plan.requests).toEqual([]);
    expect(plan.entries).toEqual([{ file: { status: 'M', path: 'image.png' }, skipped: 'binary' }]);
  });
  it('diff も省略理由もない入力は拒否する', () => {
    expect(() => planExplanation([{ status: 'M', path: 'a.ts' } as never])).toThrow('diff も省略理由もありません');
  });
  it('変更 0 件では送るファイルも 0 件', () => {
    expect(planExplanation([])).toEqual({ entries: [], requests: [] });
  });

  it('内容の変わらないリネームの空の diff も送る', () => {
    expect(planExplanation([source('new.ts', '', { status: 'R', oldPath: 'old.ts' })]).requests).toHaveLength(1);
  });

  it('1 ファイルの上限ちょうどは送り、1 バイト超えると省略する', () => {
    const plan = planExplanation([
      source('limit.ts', diff(EXPLANATION_FILE_MAX_BYTES)),
      source('over.ts', diff(EXPLANATION_FILE_MAX_BYTES + 1)),
    ]);
    expect(plan.requests.map(({ file }) => file.path)).toEqual(['limit.ts']);
    expect(plan.entries[1]).toMatchObject({ skipped: 'tooLarge' });
  });

  it('上限は UTF-8 のバイト数で数える', () => {
    // 「あ」は 3 バイト。文字数では上限内でもバイト数で超える。
    const text = 'あ'.repeat(Math.floor(EXPLANATION_FILE_MAX_BYTES / 3) + 1);
    expect(planExplanation([source('ja.ts', text)]).entries[0]).toMatchObject({ skipped: 'tooLarge' });
  });

  it('全体の上限ちょうどまで送り、超えるファイルだけ省略して後続の収まるファイルは送る', () => {
    const files = [1, 2, 3, 4].map((index) => source(`f${index}.ts`, diff(EXPLANATION_FILE_MAX_BYTES)));
    const plan = planExplanation([...files, source('over.ts', diff(1)), source('empty.ts', '')]);
    expect(EXPLANATION_TOTAL_MAX_BYTES).toBe(4 * EXPLANATION_FILE_MAX_BYTES);
    expect(plan.requests.map(({ file }) => file.path)).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'empty.ts']);
    expect(plan.entries[4]).toMatchObject({ file: { path: 'over.ts' }, skipped: 'tooLarge' });
  });

  it('1 ファイルの上限で省略したファイルは全体の合計に数えない', () => {
    const files = [1, 2, 3, 4].map((index) => source(`f${index}.ts`, diff(EXPLANATION_FILE_MAX_BYTES)));
    const plan = planExplanation([source('over.ts', diff(EXPLANATION_FILE_MAX_BYTES + 1)), ...files]);
    expect(plan.entries[0]).toMatchObject({ skipped: 'tooLarge' });
    expect(plan.requests.map(({ id, file }) => [id, file.path])).toEqual([
      ['F1', 'f1.ts'],
      ['F2', 'f2.ts'],
      ['F3', 'f3.ts'],
      ['F4', 'f4.ts'],
    ]);
  });

  it('同じパスが重複した入力は拒否する', () => {
    expect(() => planExplanation([source('a.ts'), { status: 'M', path: 'a.ts', skipped: 'binary' }])).toThrow(
      '解説の対象に同じパスが重複しています',
    );
  });
});

describe('explanationPrompt', () => {
  it('境界文・出力形式・ID・パス・状態・旧パス・diff を並べる', () => {
    const { requests } = planExplanation([
      source('src/a.ts', '@@ -1 +1 @@\n-a\n+b'),
      source('new.ts', '', { status: 'R', oldPath: 'old.ts' }),
    ]);
    const prompt = explanationPrompt(requests);
    expect(prompt).toContain(EXPORT_DATA_BOUNDARY);
    expect(prompt).toContain('{"files":[{"id":"F1","markdown":"..."}]}');
    expect(prompt).toContain('日本語');
    expect(prompt).toContain('## F1\n\nファイル: "src/a.ts"\n\nステータス: M\n\n```diff\n@@ -1 +1 @@\n-a\n+b\n```');
    expect(prompt).toContain('## F2\n\nファイル: "new.ts"\n\nステータス: R\n\n変更元: "old.ts"\n\n```diff\n\n```');
    expect(EXPLANATION_PROMPT_VERSION).toBe(1);
  });

  it('指示文・境界文・各ファイルの順に並べる', () => {
    const prompt = explanationPrompt(planExplanation([source('a.ts'), source('b.ts')]).requests);
    const positions = ['出力は次の形式の JSON だけ', EXPORT_DATA_BOUNDARY, '## F1', '## F2'].map((text) =>
      prompt.indexOf(text),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
  it('パスの改行・バッククォート・制御文字・山括弧をエスケープし、見出しを偽装させない', () => {
    const path = 'a\n## F9\n`x`<b>‮.ts';
    const prompt = explanationPrompt(planExplanation([source(path)]).requests);
    expect(prompt).toContain('ファイル: "a\\n## F9\\n\\u0060x\\u0060\\u003cb\\u003e\\u202e.ts"');
    expect(prompt).not.toContain('\n## F9');
  });

  it('変更元の改行・見出し風の文字列もエスケープする', () => {
    const oldPath = 'old\n## F9\n`x`.ts';
    const prompt = explanationPrompt(planExplanation([source('new.ts', '', { status: 'R', oldPath })]).requests);
    expect(prompt).toContain('変更元: "old\\n## F9\\n\\u0060x\\u0060.ts"');
    expect(prompt).not.toContain('\n## F9');
  });

  it('diff にバッククォートの連なりがあれば、それより長いフェンスで囲む', () => {
    const text = '+```\n+````js\n+code';
    const prompt = explanationPrompt(planExplanation([source('a.md', text)]).requests);
    expect(prompt).toContain(`\`\`\`\`\`diff\n${text}\n\`\`\`\`\``);
  });

  it('送るファイルが 0 件ならプロンプトを作らない', () => {
    expect(() => explanationPrompt([])).toThrow('解説を依頼するファイルがありません');
  });
});

describe('parseExplanationOutput', () => {
  const ids = ['F1', 'F2'];
  const ok = output([
    { id: 'F1', markdown: '# a' },
    { id: 'F2', markdown: 'b' },
  ]);

  it('ID ごとの markdown を返す', () => {
    expect(parseExplanationOutput(ok, ids)).toEqual({
      markdown: new Map([
        ['F1', '# a'],
        ['F2', 'b'],
      ]),
      missing: [],
      invalid: [],
      ignored: 0,
    });
  });

  it('全体を囲むフェンスを 1 組だけ外す', () => {
    for (const text of [
      `\`\`\`json\n${ok}\n\`\`\``,
      `\n\`\`\`\n${ok}\n\`\`\`\n`,
      `\`\`\`\`JSON\r\n${ok}\r\n\`\`\`\``,
    ]) {
      expect(parseExplanationOutput(text, ids).missing).toEqual([]);
    }
  });

  it('二重のフェンスや閉じないフェンスは JSON として読めない', () => {
    for (const text of [
      `\`\`\`json\n\`\`\`json\n${ok}\n\`\`\`\n\`\`\``,
      `\`\`\`json\n${ok}`,
      `\`\`\`json\n${ok}\n\`\`\`\``,
    ]) {
      expect(() => parseExplanationOutput(text, ids)).toThrow(ExplanationOutputError);
    }
  });

  it.each([
    ['言語名の前に空白があるフェンス', '``` json\n{"files":[{"id":"F1","markdown":"a"}]}\n```'],
    ['BOM と前後の空白', '\uFEFF {"files":[{"id":"F1","markdown":"a"}]} \n'],
  ])('%s も読める', (_, text) => {
    expect([...parseExplanationOutput(text, ['F1']).markdown]).toEqual([['F1', 'a']]);
  });
  it('JSON として読めない出力は、構文エラーを原因として残す', () => {
    const error = (() => {
      try {
        return parseExplanationOutput('not json', ['F1']);
      } catch (reason) {
        return reason;
      }
    })();
    expect(error).toBeInstanceOf(ExplanationOutputError);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });
  it('欠けた ID は missing に入れ、余分な ID は捨てて数える', () => {
    const result = parseExplanationOutput(
      output([
        { id: 'F1', markdown: 'a' },
        { id: 'F9', markdown: 'x' },
        { id: 'new.ts', markdown: 'y' },
      ]),
      ids,
    );
    expect([...result.markdown.keys()]).toEqual(['F1']);
    expect(result.missing).toEqual(['F2']);
    expect(result.ignored).toBe(2);
  });

  it('依頼していない ID は本文を検査せずに捨てる', () => {
    const result = parseExplanationOutput(
      output([
        { id: 'F9', markdown: '' },
        { id: 'F8', markdown: 'a'.repeat(EXPLANATION_MARKDOWN_MAX_BYTES + 1) },
        { id: 'F7', markdown: 1 },
        { id: 'F9' },
        { id: 'F1', markdown: 'a' },
        { id: 'F2', markdown: 'b' },
      ]),
      ids,
    );
    expect(result).toMatchObject({ missing: [], invalid: [], ignored: 4 });
    expect([...result.markdown.keys()]).toEqual(['F1', 'F2']);
  });

  it('files が空なら全件が欠ける', () => {
    expect(parseExplanationOutput(output([]), ids).missing).toEqual(ids);
  });

  it('同じ ID の重複は失敗にする', () => {
    expect(() =>
      parseExplanationOutput(
        output([
          { id: 'F1', markdown: 'a' },
          { id: 'F1', markdown: 'b' },
        ]),
        ids,
      ),
    ).toThrow('同じ ID の解説が重複しています: F1');
  });

  it.each([
    ['空の出力', ''],
    ['JSON でない', 'Sorry, I cannot help with that.'],
    ['前置きのある JSON', `結果です:\n${ok}`],
    ['配列', '[]'],
    ['null', 'null'],
    ['files がない', '{}'],
    ['files が配列でない', '{"files":{}}'],
    ['要素がオブジェクトでない', output(['F1'])],
    ['id が文字列でない', output([{ id: 1, markdown: 'a' }])],
    ['markdown が文字列でない', output([{ id: 'F1', markdown: ['a'] }])],
    ['markdown がない', output([{ id: 'F1' }])],
  ])('%s は失敗にする', (_, text) => {
    expect(() => parseExplanationOutput(text, ids)).toThrow(ExplanationOutputError);
  });

  it('空白だけの解説はその ID だけ解説なしにする', () => {
    const result = parseExplanationOutput(
      output([
        { id: 'F1', markdown: ' \n' },
        { id: 'F2', markdown: 'b' },
      ]),
      ids,
    );
    expect(result).toMatchObject({ missing: [], invalid: ['F1'], ignored: 0 });
    expect([...result.markdown.keys()]).toEqual(['F2']);
  });

  it('markdown の上限ちょうどは受け取り、1 バイト超えるとその ID だけ解説なしにする', () => {
    const limit = 'a'.repeat(EXPLANATION_MARKDOWN_MAX_BYTES);
    const result = parseExplanationOutput(
      output([
        { id: 'F1', markdown: limit },
        { id: 'F2', markdown: `${limit}a` },
      ]),
      ids,
    );
    expect(result.markdown.get('F1')).toBe(limit);
    expect(result).toMatchObject({ missing: [], invalid: ['F2'] });
  });

  it('markdown の上限は UTF-8 のバイト数で数える', () => {
    // 「あ」は 3 バイト。文字数では上限内でもバイト数で超える。
    const markdown = 'あ'.repeat(Math.floor(EXPLANATION_MARKDOWN_MAX_BYTES / 3) + 1);
    expect(markdown.length).toBeLessThan(EXPLANATION_MARKDOWN_MAX_BYTES);
    expect(parseExplanationOutput(output([{ id: 'F1', markdown }]), ids)).toMatchObject({ invalid: ['F1'] });
  });

  it('解説が不正な ID の重複も失敗にする', () => {
    expect(() =>
      parseExplanationOutput(
        output([
          { id: 'F1', markdown: '' },
          { id: 'F1', markdown: 'a' },
        ]),
        ids,
      ),
    ).toThrow('同じ ID の解説が重複しています: F1');
  });

  it('HTML を含む markdown も文字列のまま返す（表示側でエスケープする）', () => {
    const markdown = '<script>alert(1)</script>';
    expect(parseExplanationOutput(output([{ id: 'F1', markdown }]), ['F1']).markdown.get('F1')).toBe(markdown);
  });

  it('失敗の理由をメッセージに含める', () => {
    expect(() => parseExplanationOutput('not json', ids)).toThrow('解説の出力が不正です: JSON として読めません');
  });
});

describe('explanationRecord / isStoredExplanation', () => {
  const plan = planExplanation([
    { status: 'M', path: 'image.png', skipped: 'binary' },
    source('a.ts'),
    source('new.ts', 'r', { status: 'R', oldPath: 'old.ts' }),
    source('c.ts'),
  ]);
  const record = explanationRecord(
    plan,
    parseExplanationOutput(
      output([
        { id: 'F1', markdown: '# a' },
        { id: 'F3', markdown: ' ' },
      ]),
      ['F1', 'F2', 'F3'],
    ),
    {
      comparison: '["/repo","b","a",null]',
      agent: 'claude',
      generatedAt: '2026-11-26T00:00:00.000Z',
    },
  );

  it('入力順にファイルごとの解説または解説なしの理由を持つ', () => {
    expect(record).toEqual({
      version: 1,
      comparison: '["/repo","b","a",null]',
      agent: 'claude',
      generatedAt: '2026-11-26T00:00:00.000Z',
      promptVersion: EXPLANATION_PROMPT_VERSION,
      files: [
        { status: 'M', path: 'image.png', skipped: 'binary' },
        { status: 'M', path: 'a.ts', markdown: '# a' },
        { status: 'R', path: 'new.ts', oldPath: 'old.ts', skipped: 'missing' },
        { status: 'M', path: 'c.ts', skipped: 'invalid' },
      ],
    });
    expect(isStoredExplanation(JSON.parse(JSON.stringify(record)))).toBe(true);
  });

  it('理由ごとの表示文を持つ', () => {
    expect(EXPLANATION_SKIP_LABELS).toEqual({
      binary: 'バイナリのため解説なし',
      submodule: 'サブモジュールのため解説なし',
      tooLarge: '大きすぎるため省略',
      missing: '出力に含まれないため解説なし',
      invalid: '出力が不正のため解説なし',
    });
  });

  it.each([
    ['null', null],
    ['版が違う', { ...record, version: 2 }],
    ['未対応のエージェント', { ...record, agent: 'codex' }],
    ['プロンプトの版が正の整数でない', { ...record, promptVersion: 0 }],
    ['generatedAt がない', { ...record, generatedAt: undefined }],
    ['generatedAt が日時として読めない', { ...record, generatedAt: 'invalid date' }],
    ['files に穴がある', { ...record, files: new Array(1) }],
    ['comparison がない', { ...record, comparison: 1 }],
    ['files が配列でない', { ...record, files: {} }],
    ['不正なパス', { ...record, files: [{ status: 'M', path: '../x', markdown: 'a' }] }],
    ['不正な状態', { ...record, files: [{ status: 'X', path: 'a', markdown: 'a' }] }],
    ['解説も理由もない', { ...record, files: [{ status: 'M', path: 'a' }] }],
    ['解説と理由の両方', { ...record, files: [{ status: 'M', path: 'a', markdown: 'a', skipped: 'binary' }] }],
    ['不明な理由', { ...record, files: [{ status: 'M', path: 'a', skipped: 'other' }] }],
    ['解説と不明な理由の両方', { ...record, files: [{ status: 'M', path: 'a', markdown: 'a', skipped: 'other' }] }],
    ['理由が null', { ...record, files: [{ status: 'M', path: 'a', skipped: null }] }],
    ['空白だけの解説', { ...record, files: [{ status: 'M', path: 'a', markdown: ' \n' }] }],
    [
      '上限を超える解説',
      { ...record, files: [{ status: 'M', path: 'a', markdown: 'a'.repeat(EXPLANATION_MARKDOWN_MAX_BYTES + 1) }] },
    ],
    [
      'パスの重複',
      {
        ...record,
        files: [
          { status: 'M', path: 'a', markdown: 'a' },
          { status: 'M', path: 'a', skipped: 'binary' },
        ],
      },
    ],
  ])('%s は保存データとして受け付けない', (_, value) => {
    expect(isStoredExplanation(value)).toBe(false);
  });
});
