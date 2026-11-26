import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../src/core/markdown';

// 出力に許すタグ。属性は ol の start だけを許す。
const ALLOWED_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'strong',
  'em',
  'hr',
  'blockquote',
]);
function tags(html: string): string[] {
  return [...html.matchAll(/<\/?([^\s>/]+)([^>]*)>/g)].map(([tag, name, attributes]) => {
    if (name === 'ol' && tag.startsWith('<ol ')) {
      expect(attributes, tag).toMatch(/^ start="[0-9]{1,9}"$/);
    } else {
      expect(attributes, tag).toBe('');
    }
    return name!;
  });
}

// 開きタグと閉じタグが交差せずに対応しているか。hr は閉じない。
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>/g)) {
    if (name === 'hr') {
      continue;
    }
    if (!closing) {
      stack.push(name!);
    } else if (stack.pop() !== name) {
      return false;
    }
  }
  return stack.length === 0;
}

describe('escapeHtml', () => {
  it('HTML の特殊文字と引用符をエスケープする', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;',
    );
    expect(escapeHtml('')).toBe('');
  });
});

describe('renderMarkdown', () => {
  it.each([
    ['見出し', '# 一\n###### 六 ##', '<h1>一</h1>\n<h6>六</h6>'],
    ['7 個の # は見出しにしない', '####### 七', '<p>####### 七</p>'],
    ['# の後に空白がなければ見出しにしない', '#tag', '<p>#tag</p>'],
    ['段落', 'a\nb\n\nc', '<p>a\nb</p>\n<p>c</p>'],
    ['箇条書き', '- a\n* b', '<ul><li>a</li><li>b</li></ul>'],
    ['番号付き', '1. a\n2) b', '<ol><li>a</li><li>b</li></ol>'],
    ['種類が変われば別のリスト', '- a\n1. b', '<ul><li>a</li></ul>\n<ol><li>b</li></ol>'],
    ['入れ子は 1 段', '- a\n  - b\n  1. c\n- d', '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>'],
    ['2 段以上の入れ子は平らにする', '- a\n  - b\n    - c', '<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>'],
    ['親のない字下げの項目は 1 段目にする', '  - a', '<ul><li>a</li></ul>'],
    ['項目の続きの行', '- a\n  続き', '<ul><li>a\n続き</li></ul>'],
    ['水平線', 'a\n\n---\n* * *', '<p>a</p>\n<hr>\n<hr>'],
    ['引用', '> a\n> > b', '<blockquote><p>a</p>\n<blockquote><p>b</p></blockquote></blockquote>'],
    ['インラインコード', 'a `<b>` ``x ` y`` c', '<p>a <code>&lt;b&gt;</code> <code>x ` y</code> c</p>'],
    [
      '強調',
      '**太字** と *斜体* と **入れ子 *斜体***',
      '<p><strong>太字</strong> と <em>斜体</em> と <strong>入れ子 <em>斜体</em></strong></p>',
    ],
    ['対にならない強調記号', '**a と *b と ** c **', '<p>**a と *b と ** c **</p>'],
    ['コードの中の強調記号', '`**a**`', '<p><code>**a**</code></p>'],
    ['閉じないインラインコード', 'a `b', '<p>a `b</p>'],
    ['空入力', '', ''],
    ['空白だけ', ' \n\t\n', ''],
    ['CRLF', '# a\r\n\r\nb\r\nc', '<h1>a</h1>\n<p>b\nc</p>'],
  ])('%s', (_, markdown, html) => {
    expect(renderMarkdown(markdown)).toBe(html);
  });

  it('フェンスの中の Markdown と HTML は文字のまま出し、言語名は使わない', () => {
    expect(renderMarkdown('```ts" onclick="x\n# 見出しではない\n<script>alert(1)</script>\n**a**\n```\n後')).toBe(
      '<pre><code># 見出しではない\n&lt;script&gt;alert(1)&lt;/script&gt;\n**a**</code></pre>\n<p>後</p>',
    );
    expect(renderMarkdown('~~~~\n```\n~~~\n~~~~')).toBe('<pre><code>```\n~~~</code></pre>');
  });

  it('閉じないフェンスは文書の終わりまでをコードにする', () => {
    expect(renderMarkdown('a\n```\n- b\n\n# c')).toBe('<p>a</p>\n<pre><code>- b\n\n# c</code></pre>');
  });

  it('リンク・画像・生の HTML・表はタグにせず、URL も文字として出す', () => {
    const html = renderMarkdown(
      '[x](javascript:alert(1)) ![i](https://example.com/a.png) <https://example.com>\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(html).toContain('[x](javascript:alert(1))');
    expect(html).toContain('![i](https://example.com/a.png)');
    expect(html).toContain('&lt;https://example.com&gt;');
    expect(html).toContain('| a | b |');
    expect(tags(html)).toEqual(['p', 'p', 'p', 'p']);
  });

  it.each([
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<img src=x onerror="alert(1)">', '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'],
    ['<a href="javascript:alert(1)">x</a>', '&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;'],
    ['# <style>body{}</style>\n- <iframe src="x">\n> <svg onload=alert(1)>', '&lt;iframe src=&quot;x&quot;&gt;'],
    ['**<b onmouseover="x">**', '&lt;b onmouseover=&quot;x&quot;&gt;'],
    ['`</code><script>`', '&lt;/code&gt;&lt;script&gt;'],
    [
      '```\n</code></pre><script>alert(1)</script>\n```',
      '&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    ],
    ['" onerror="alert(1)\' data-x=\'', '&quot; onerror=&quot;alert(1)&#39; data-x=&#39;'],
    ['<!-- コメント --><![CDATA[x]]>', '&lt;!-- コメント --&gt;&lt;![CDATA[x]]&gt;'],
    [
      '007. " onmouseover="x <ol start="1" onclick="x">',
      '<ol start="7"><li>&quot; onmouseover=&quot;x &lt;ol start=&quot;1&quot; onclick=&quot;x&quot;&gt;',
    ],
  ])('悪意ある入力 %j はエスケープして許可したタグと属性だけを出す', (markdown, fragment) => {
    const html = renderMarkdown(markdown);
    for (const tag of tags(html)) {
      expect(ALLOWED_TAGS.has(tag), tag).toBe(true);
    }
    expect(balanced(html)).toBe(true);
    expect(html).not.toMatch(/<(?:script|img|a|style|iframe|svg|b)\b/i);
    expect(html).toContain(fragment);
  });

  it.each([
    ['***a***', '<p><strong><em>a</em></strong></p>'],
    ['**a *b** c*', '<p><strong>a *b</strong> c*</p>'],
    ['*a **b* c**', '<p>*a <strong>b* c</strong></p>'],
    ['x ***', '<p>x ***</p>'],
    ['** *a* **', '<p>** <em>a</em> **</p>'],
    ['- **a\n  - *b**', '<ul><li>**a<ul><li><em>b</em>*</li></ul></li></ul>'],
    ['**`foo.ts`** を直す', '<p><strong><code>foo.ts</code></strong> を直す</p>'],
    ['*x `b` y*', '<p><em>x <code>b</code> y</em></p>'],
    ['`**a**` と `*b*`', '<p><code>**a**</code> と <code>*b*</code></p>'],
    ['x <1> y `c`', '<p>x &lt;1&gt; y <code>c</code></p>'],
    ['``a `b`` c `d`', '<p><code>a `b</code> c <code>d</code></p>'],
  ])('強調とコードの組み合わせ %j', (markdown, html) => {
    const rendered = renderMarkdown(markdown);
    expect(rendered).toBe(html);
    expect(balanced(rendered)).toBe(true);
  });

  it.each([
    ['同じ行で閉じるバッククォートはインラインコード', '```a``` 後\n次', '<p><code>a</code> 後\n次</p>'],
    ['チルダのフェンスは後ろの文字を問わない', '~~~a~\nb\n~~~', '<pre><code>b</code></pre>'],
    ['空行を挟む番号付きリストは 1 つのリスト', '1. a\n\n2. b', '<ol><li>a</li><li>b</li></ol>'],
    [
      'フェンスの後の番号付きリスト',
      '1. 手順A\n```\ncmd\n```\n2. 手順B',
      '<ol><li>手順A</li></ol>\n<pre><code>cmd</code></pre>\n<ol start="2"><li>手順B</li></ol>',
    ],
    ['段落の後の番号付きリスト', '1. a\n\nb\n\n3. c', '<ol><li>a</li></ol>\n<p>b</p>\n<ol start="3"><li>c</li></ol>'],
    ['0 から始まる番号付きリスト', '0. a', '<ol start="0"><li>a</li></ol>'],
    ['9 桁の開始番号', '999999999. a', '<ol start="999999999"><li>a</li></ol>'],
    ['10 桁の開始番号は段落', '1000000000. a', '<p>1000000000. a</p>'],
    ['開始番号の先頭のゼロは除く', '007. a\n12. b', '<ol start="7"><li>a</li><li>b</li></ol>'],
    ['ゼロ埋めした 1 から始まる番号付きリスト', '001) a', '<ol><li>a</li></ol>'],
    ['開始番号に数字以外を含む行は段落', '7"onclick="x. a', '<p>7&quot;onclick=&quot;x. a</p>'],
    ['空行を挟む子の項目', '- a\n\n  - b', '<ul><li>a<ul><li>b</li></ul></li></ul>'],
    ['空行の後の字下げした続き', '- a\n\n  続き', '<ul><li>a\n続き</li></ul>'],
    ['空行の後の段落はリストを閉じる', '- a\n\n段落', '<ul><li>a</li></ul>\n<p>段落</p>'],
    ['空行の後の別の種類の項目は別のリスト', '- a\n\n1. b', '<ul><li>a</li></ul>\n<ol><li>b</li></ol>'],
    ['全体を字下げしたリストの項目は兄弟', '  - a\n  - b', '<ul><li>a</li><li>b</li></ul>'],
    ['子と同じ字下げの続きは子に付く', '- a\n  - b\n  続き', '<ul><li>a<ul><li>b\n続き</li></ul></li></ul>'],
    [
      '親と同じ字下げの続きは子リストの後に付く',
      '- 最初\n  - 補足\n最後',
      '<ul><li>最初<ul><li>補足</li></ul>最後</li></ul>',
    ],
    [
      '親の続きの前後に子リストがある',
      '- a\n  - b\nc\n  続き\n  4) d\n  e',
      '<ul><li>a<ul><li>b</li></ul>c\n続き<ol start="4"><li>d\ne</li></ol></li></ul>',
    ],
    ['子リストの番号付き', '- a\n  1. b\n  2. c', '<ul><li>a<ol><li>b</li><li>c</li></ol></li></ul>'],
    ['段落の後の見出し', 'a\n# h', '<p>a</p>\n<h1>h</h1>'],
    ['段落の後の水平線', 'a\n---', '<p>a</p>\n<hr>'],
    ['段落の後の引用', 'a\n> q', '<p>a</p>\n<blockquote><p>q</p></blockquote>'],
    ['段落の後の項目', 'a\n- i', '<p>a</p>\n<ul><li>i</li></ul>'],
    ['項目の後の見出し', '- i\n# h', '<ul><li>i</li></ul>\n<h1>h</h1>'],
    ['項目の後の水平線', '- i\n---', '<ul><li>i</li></ul>\n<hr>'],
    ['項目の後の引用', '- i\n> q', '<ul><li>i</li></ul>\n<blockquote><p>q</p></blockquote>'],
    ['項目の後のフェンス', '- i\n```\nc\n```', '<ul><li>i</li></ul>\n<pre><code>c</code></pre>'],
    ['引用の終わり', '> a\nb', '<blockquote><p>a</p></blockquote>\n<p>b</p>'],
    [
      '引用の深さの上限より深い引用は段落',
      '> > > > d',
      '<blockquote><blockquote><blockquote><p>d</p></blockquote></blockquote></blockquote>',
    ],
    ['見出しの途中の # は残す', '# a #b', '<h1>a #b</h1>'],
    ['見出しの末尾の # と空白を外す', '# a ##  ', '<h1>a</h1>'],
  ])('%s', (_, markdown, html) => {
    expect(renderMarkdown(markdown)).toBe(html);
  });

  it('引用が 1 万段あっても 3 段までをタグにする', () => {
    const input = `${'> '.repeat(10_000)}本文`;
    const started = Date.now();
    const html = renderMarkdown(input);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(html).toBe(
      `<blockquote><blockquote><blockquote><p>${'&gt; '.repeat(9996)}本文</p></blockquote></blockquote></blockquote>`,
    );
  });

  it.each([
    ['見出し', '# a\u2028b', '<h1>a\u2028b</h1>'],
    ['引用', '> a\u2029b', '<blockquote><p>a\u2029b</p></blockquote>'],
    ['項目', '1. a\u2028b', '<ol><li>a\u2028b</li></ol>'],
    ['フェンス', '```ts\u2028x\ncode\n```', '<pre><code>code</code></pre>'],
  ])('U+2028・U+2029 を含む行も%sとして扱う', (_, input, expected) => {
    expect(renderMarkdown(input)).toBe(expected);
  });

  it('U+2028 を含む行の長い空白でも後戻りせずに処理する', () => {
    const input = `#${' '.repeat(60_000)}本文\u2028続き`;
    const started = Date.now();
    const html = renderMarkdown(input);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(html).toBe('<h1>本文\u2028続き</h1>');
  });

  it('長い行や多数の記号でも線形の時間で強調・コード・見出しを処理する', () => {
    const inputs = [
      `# a${' '.repeat(100_000)}x`,
      `x ${'** '.repeat(50_000)}**b**`,
      `x ${'* x '.repeat(50_000)}*c*`,
      // 長さの違う閉じないバッククォート列の後のインラインコード。
      `x ${Array.from({ length: 2000 }, (_, index) => '`'.repeat(index + 2)).join(' a ')} \`d\``,
    ];
    expect(inputs[3]!.length).toBeGreaterThanOrEqual(1_000_000);
    const started = Date.now();
    const html = inputs.map((input) => renderMarkdown(input));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(html[0]).toMatch(/^<h1>a {100000}x<\/h1>$/);
    expect(html[1]).toContain('<strong>b</strong>');
    expect(html[2]).toContain('<em>');
    expect(html[3]).toContain('<code>d</code>');
  });
});
