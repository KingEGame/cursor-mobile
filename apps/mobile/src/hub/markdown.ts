/**
 * Small Markdown parser for agent transcripts on the phone.
 * Covers what Cursor agents actually emit: headings, paragraphs, lists, fenced code,
 * pipe tables, and inline bold / italic / code / links. Anything else stays plain text.
 */

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export type Block =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; items: Array<{ ordered: boolean; marker: string; depth: number; spans: Span[] }> }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] };

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Inline: **bold**, __bold__, *italic*, _italic_, `code`, [text](url). */
export function parseInline(input: string): Span[] {
  const spans: Span[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (let m = pattern.exec(input); m; m = pattern.exec(input)) {
    if (m.index > last) spans.push({ text: input.slice(last, m.index) });
    const token = m[0];
    if (m[1]) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (m[2]) {
      for (const inner of parseInline(token.slice(2, -2))) spans.push({ ...inner, bold: true });
    } else if (m[3]) {
      const close = token.indexOf('](');
      spans.push({ text: token.slice(1, close), link: token.slice(close + 2, -1) });
    } else {
      for (const inner of parseInline(token.slice(1, -1))) spans.push({ ...inner, italic: true });
    }
    last = m.index + token.length;
  }
  if (last < input.length) spans.push({ text: input.slice(last) });
  return spans;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'paragraph', spans: parseInline(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]!); i++) body.push(lines[i]!);
      blocks.push({ kind: 'code', lang: fence[1] || null, text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      flushPara();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!.trim()) });
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      flushPara();
      const header = splitRow(line).map(parseInline);
      const rows: Span[][][] = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]!); i++) {
        rows.push(splitRow(lines[i]!).map(parseInline));
      }
      i--;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const prev = blocks[blocks.length - 1];
      const entry = {
        ordered: /\d/.test(item[2]!),
        marker: item[2]!,
        depth: Math.floor(item[1]!.replace(/\t/g, '  ').length / 2),
        spans: parseInline(item[3]!),
      };
      if (prev?.kind === 'list') prev.items.push(entry);
      else blocks.push({ kind: 'list', items: [entry] });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return blocks;
}
