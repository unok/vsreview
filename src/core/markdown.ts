// LLM の出力など信頼できない Markdown を表示用の HTML にする。
// 全文を先にエスケープし、決まった構文だけをタグにする。属性は番号付きリストの start だけを出す。
// リンク・画像・生の HTML・表は文字のまま出す。

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

// 引用の入れ子をこの深さまでタグにし、それより深い引用は段落として出す。
const MAX_QUOTE_DEPTH = 3;
// 「.」が一致しない U+2028・U+2029 を含む行で後戻りを起こさないよう、行の残りは s フラグで受ける。
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/s;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// エスケープ後の「>」で引用を判定する。
const QUOTE = /^ {0,3}&gt; ?(.*)$/s;
const ITEM = /^( *)([-*]|\d{1,9}[.)])[ \t]+(.*)$/s;
// リストの最初の項目よりこの幅以上深い項目・続きの行を、1 段の入れ子として扱う。
const NESTED_INDENT = 2;

export function renderMarkdown(markdown: string): string {
  return renderBlocks(escapeHtml(markdown).split(/\r\n|\r|\n/), 0);
}

interface ListItem {
  parts: (string[] | List)[];
}
interface List {
  start: number | undefined;
  items: ListItem[];
}
interface BlockList extends List {
  // 最初の項目の字下げ。入れ子はこれとの相対で判定する。
  indent: number;
  // 空行の後で、次の行がリストの続きかどうかをまだ決めていない。
  blank: boolean;
}

function indentOf(line: string): number {
  let width = 0;
  while (line[width] === ' ') {
    width++;
  }
  return width;
}

// バッククォートのフェンスは、記号列の後ろにバッククォートがない行だけを開始とする。
function fenceMarker(line: string): string | undefined {
  const match = FENCE.exec(line);
  const marker = match?.[1];
  return marker && !(marker.startsWith('`') && match[2]!.includes('`')) ? marker : undefined;
}

function isBlockStart(line: string): boolean {
  return Boolean(fenceMarker(line)) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line);
}

function renderBlocks(lines: readonly string[], depth: number): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: BlockList | undefined;
  const flushParagraph = (): void => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      html.push(renderList(list));
      list = undefined;
    }
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) {
      flushParagraph();
      if (list) {
        list.blank = true;
      }
      continue;
    }
    const item = ITEM.exec(line);
    if (list && !isBlockStart(line) && continuesList(list, line, item)) {
      addToList(list, line, item);
      continue;
    }
    flushList();
    const marker = fenceMarker(line);
    if (marker) {
      flushParagraph();
      const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const code: string[] = [];
      // 閉じないフェンスは文書の終わりまでをコードにする。
      while (++index < lines.length && !closing.test(lines[index]!)) {
        code.push(lines[index]!);
      }
      html.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(headingText(heading[2]!))}</h${level}>`);
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      html.push('<hr>');
      continue;
    }
    if (QUOTE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      for (; index < lines.length; index++) {
        const match = QUOTE.exec(lines[index]!);
        if (!match) {
          break;
        }
        quoted.push(match[1]!);
      }
      index--;
      html.push(
        depth < MAX_QUOTE_DEPTH
          ? `<blockquote>${renderBlocks(quoted, depth + 1)}</blockquote>`
          : `<p>${renderInline(quoted.join('\n'))}</p>`,
      );
      continue;
    }
    if (item) {
      flushParagraph();
      list = { start: listStart(item[2]!), indent: item[1]!.length, items: [], blank: false };
      addToList(list, line, item);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return html.join('\n');
}

// ITEM で検証した 1〜9 桁の数字を整数に直す。
function listStart(marker: string): number | undefined {
  return /\d/.test(marker) ? Number(marker.slice(0, -1)) : undefined;
}
function isNested(list: BlockList, indent: number): boolean {
  return indent >= list.indent + NESTED_INDENT;
}

// 空行の後は、同じ種類の項目・入れ子の項目・字下げした続きの行だけをリストの続きとする。
function continuesList(list: BlockList, line: string, item: RegExpExecArray | null): boolean {
  if (item) {
    return isNested(list, item[1]!.length) || (listStart(item[2]!) !== undefined) === (list.start !== undefined);
  }
  return !list.blank || isNested(list, indentOf(line));
}

function addToList(list: BlockList, line: string, item: RegExpExecArray | null): void {
  list.blank = false;
  const parent = list.items.at(-1);
  const lastPart = parent?.parts.at(-1);
  const children = Array.isArray(lastPart) ? undefined : lastPart;
  if (!item) {
    // 子リストの直後に字下げした行は子に付け、親の本文が再開したら子リストを閉じる。
    const child = isNested(list, indentOf(line)) ? children?.items.at(-1) : undefined;
    const target = child ?? parent!;
    const text = target.parts.at(-1);
    if (Array.isArray(text)) {
      text.push(line.trim());
    } else {
      target.parts.push([line.trim()]);
    }
    return;
  }
  const entry = { parts: [[item[3]!]] };
  if (parent && isNested(list, item[1]!.length)) {
    // 2 段以上の入れ子や種類の違う入れ子も、1 段目の入れ子の項目として平らに出す。
    if (children) {
      children.items.push(entry);
    } else {
      parent.parts.push({ start: listStart(item[2]!), items: [entry] });
    }
    return;
  }
  list.items.push(entry);
}

function renderList({ start, items }: List): string {
  const tag = start === undefined ? 'ul' : 'ol';
  const attributes = start !== undefined && start !== 1 ? ` start="${String(start)}"` : '';
  const content = items
    .map(
      ({ parts }) =>
        `<li>${parts.map((part) => (Array.isArray(part) ? renderInline(part.join('\n')) : renderList(part))).join('')}</li>`,
    )
    .join('');
  return `<${tag}${attributes}>${content}</${tag}>`;
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}
// 見出しの末尾の空白と、空白の後ろの「#」の連なりを行末から外す。正規表現の後戻りを避ける。
function headingText(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) {
    end--;
  }
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === '#') {
    hashes--;
  }
  if (hashes < end && (hashes === 0 || isSpace(text[hashes - 1]))) {
    end = hashes;
    while (end > 0 && isSpace(text[end - 1])) {
      end--;
    }
  }
  return text.slice(0, end);
}

// インラインコードを先に保護してから文全体で強調を処理し、最後にコードを戻す。
// 保護の印は「<数字>」で、エスケープ後の入力に「<」は現れないので入力と衝突しない。
function renderInline(text: string): string {
  const codes: string[] = [];
  const protectedText = protectCode(text, codes);
  return renderEmphasis(protectedText).replace(
    /<(\d+)>/g,
    (_, index: string) => `<code>${codes[Number(index)]}</code>`,
  );
}

// バッククォート列を 1 回走査し、同じ長さの次の列と対にする。対にならない列は文字のまま残す。
function protectCode(text: string, codes: string[]): string {
  const runs: { start: number; length: number }[] = [];
  for (let index = 0; index < text.length;) {
    if (text[index] !== '`') {
      index++;
      continue;
    }
    const start = index;
    while (text[index] === '`') {
      index++;
    }
    runs.push({ start, length: index - start });
  }
  // 長さごとに、まだ使っていない列の位置を並べる。
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const queue = byLength.get(run.length) ?? [];
    queue.push(index);
    byLength.set(run.length, queue);
  });
  const cursors = new Map<number, number>();
  let result = '';
  let position = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    const queue = byLength.get(run.length)!;
    let cursor = cursors.get(run.length) ?? 0;
    while (cursor < queue.length && queue[cursor]! <= index) {
      cursor++;
    }
    cursors.set(run.length, cursor);
    const closing = queue[cursor];
    if (closing === undefined) {
      continue;
    }
    const end = runs[closing]!;
    result += `${text.slice(position, run.start)}<${codes.length}>`;
    codes.push(text.slice(run.start + run.length, end.start));
    position = end.start + end.length;
    // 閉じた列までの列はコードの中なので飛ばす。
    index = closing;
  }
  return result + text.slice(position);
}

function renderEmphasis(text: string): string {
  // 斜体を太字の内と外で別々に処理し、タグが交差しないようにする。
  const italic = (part: string): string =>
    wrapPairs(
      part,
      '*',
      (content) => `<em>${content}</em>`,
      (plain) => plain,
    );
  return wrapPairs(text, '**', (content) => `<strong>${italic(content)}</strong>`, italic);
}

// 記号の次の出現と対にし、中身が空白で始まる・終わる場合は対にしない。線形時間で走査する。
function wrapPairs(
  text: string,
  marker: string,
  wrap: (content: string) => string,
  plain: (text: string) => string,
): string {
  let result = '';
  let position = 0;
  let pending = 0;
  while (position < text.length) {
    const start = text.indexOf(marker, position);
    if (start < 0) {
      break;
    }
    let end = text.indexOf(marker, start + marker.length);
    if (end < 0) {
      break;
    }
    // 「***」のような記号の連なりでは最後の記号で閉じ、内側の斜体を残す。
    while (marker.length > 1 && text[end + marker.length] === marker[0]) {
      end++;
    }
    const content = text.slice(start + marker.length, end);
    if (content && !isSpace(content[0]) && !isSpace(content.at(-1)) && content[0] !== '\n' && content.at(-1) !== '\n') {
      result += plain(text.slice(pending, start)) + wrap(content);
      position = end + marker.length;
      pending = position;
    } else {
      position = start + marker.length;
    }
  }
  return result + plain(text.slice(pending));
}
