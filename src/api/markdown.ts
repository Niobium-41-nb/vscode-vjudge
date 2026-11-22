/**
 * VJudge 题面的 Markdown 子集渲染器。
 * 输出的是未净化的 HTML，调用方必须再经过 sanitizeStatementHtml。
 * 公式（$...$、$$...$$）原样保留，由题面 Webview 的 TeX 渲染器处理。
 */

const BLOCK_HTML = /^\s{0,3}<\/?(?:table|div|p|pre|ul|ol|li|h[1-6]|blockquote|center|details|summary|figure|figcaption|section|article|aside|header|footer|img|video|audio|iframe|script|style|hr|br)\b/i;
const RAW_HTML_TAGS = new Set(['table', 'pre', 'script', 'style']);
const VOID_HTML_TAGS = new Set(['hr', 'br', 'img']);
const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

export function isMarkdownFormat(format: string): boolean {
  return /^(md|markdown)$/i.test(format.trim());
}

function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

function indentWidth(text: string): number {
  return text.replace(/\t/g, '    ').length;
}

export function renderMarkdown(source: string): string {
  if (!source) {
    return '';
  }
  return renderBlocks(source.replace(/\r\n?/g, '\n').split('\n')).trim();
}

function renderBlocks(lines: string[]): string {
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const language = fence[2];
      index++;
      const content: string[] = [];
      while (index < lines.length) {
        const closing = new RegExp(`^\\s{0,3}${marker}{${length},}\\s*$`);
        if (closing.test(lines[index])) {
          index++;
          break;
        }
        content.push(lines[index]);
        index++;
      }
      const cls = language ? ` class="language-${escapeAttribute(language)}"` : '';
      blocks.push(`<pre><code${cls}>${escapeHtml(content.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push('<hr>');
      index++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index++;
      }
      blocks.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[2]);
      const contentIndent = indentWidth(list[1]) + list[2].length + (line.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s+)/)?.[3].length ?? 1);
      const result = renderList(lines, index, indentWidth(list[1]), contentIndent, ordered);
      blocks.push(result.html);
      index = result.next;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index++;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('\n');
      blocks.push(`<table>\n<thead>\n<tr>${head}</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`);
      continue;
    }

    if (BLOCK_HTML.test(line) || /^\s{0,3}<!--/.test(line)) {
      const tag = line.match(/^\s{0,3}<([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
      const raw: string[] = [];
      if (tag && RAW_HTML_TAGS.has(tag)) {
        const closing = `</${tag}>`;
        while (index < lines.length) {
          const current = lines[index];
          raw.push(current);
          index++;
          if (current.toLowerCase().includes(closing)) {
            break;
          }
          if (!current.trim() && raw.length > 1) {
            break;
          }
        }
      } else if (tag && VOID_HTML_TAGS.has(tag)) {
        raw.push(line);
        index++;
      } else {
        while (index < lines.length && lines[index].trim()) {
          raw.push(lines[index]);
          index++;
        }
      }
      blocks.push(raw.join('\n'));
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) {
        break;
      }
      if (paragraph.length > 0 && isBlockStart(lines, index)) {
        break;
      }
      paragraph.push(current);
      index++;
    }
    blocks.push(renderParagraph(paragraph));
  }

  return blocks.join('\n');
}

function isHorizontalRule(line: string): boolean {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return (
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    isHorizontalRule(line) ||
    /^\s*([-*+]|\d{1,9}[.)])\s+/.test(line) ||
    BLOCK_HTML.test(line) ||
    (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1]))
  );
}

function renderParagraph(lines: string[]): string {
  let text = lines.join('\n').replace(/[ \t]{2,}\n/g, '\u0000BR\u0000');
  text = text.replace(/\n/g, (match, offset: number, whole: string) => {
    const before = whole[offset - 1] ?? '';
    const after = whole[offset + 1] ?? '';
    return CJK.test(before) || CJK.test(after) ? '' : ' ';
  });
  return `<p>${renderInline(text).replace(/\u0000BR\u0000/g, '<br>')}</p>`;
}

function renderList(
  lines: string[],
  start: number,
  baseIndent: number,
  contentIndent: number,
  ordered: boolean,
): { html: string; next: number } {
  const itemPattern = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)([\s\S]*)$/;
  const items: string[][] = [];
  let current: string[] | null = null;
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) {
        next++;
      }
      if (next >= lines.length) {
        index = next;
        break;
      }
      const nextMatch = lines[next].match(itemPattern);
      if (nextMatch && indentWidth(nextMatch[1]) === baseIndent && /\d/.test(nextMatch[2]) === ordered) {
        index = next;
        continue;
      }
      if (indentWidth(lines[next].match(/^\s*/)?.[0] ?? '') > baseIndent && current) {
        current.push('');
        index++;
        continue;
      }
      break;
    }

    const match = line.match(itemPattern);
    const indent = indentWidth(line.match(/^\s*/)?.[0] ?? '');
    if (match && indent === baseIndent && /\d/.test(match[2]) === ordered) {
      if (current) {
        items.push(current);
      }
      current = [match[4]];
      index++;
      continue;
    }

    if (indent > baseIndent && current) {
      current.push(line.slice(Math.min(indent, Math.max(baseIndent + 2, contentIndent))));
      index++;
      continue;
    }

    break;
  }
  if (current) {
    items.push(current);
  }

  const tag = ordered ? 'ol' : 'ul';
  const startNumber = ordered ? Number(lines[start].match(/^\s*(\d+)/)?.[1] ?? '1') : 1;
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : '';
  const html = items
    .map((item) => `<li>${stripLeadingParagraph(renderBlocks(item))}</li>`)
    .join('\n');
  return { html: `<${tag}${startAttr}>\n${html}\n</${tag}>`, next: index };
}

function stripLeadingParagraph(html: string): string {
  const trimmed = html.trim();
  const match = trimmed.match(/^<p>([\s\S]*?)<\/p>(?:\n|$)/);
  if (!match) {
    return trimmed;
  }
  const rest = trimmed.slice(match[0].length);
  if (rest && !rest.startsWith('<')) {
    return trimmed;
  }
  return match[1] + (rest ? `\n${rest}` : '');
}

function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|')) {
    text = text.slice(0, -1);
  }
  return text.split('|').map((cell) => cell.trim());
}

function renderInline(source: string): string {
  const tokens: string[] = [];
  const hold = (html: string): string => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = source;

  text = text.replace(/(`+)\s*([\s\S]*?)\s*\1/g, (_match, _ticks, code: string) => hold(`<code>${escapeHtml(code)}</code>`));

  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match) => hold(escapeText(match)));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (match) => hold(escapeText(match)));

  text = text.replace(/\${6}([\s\S]+?)\${6}/g, (match) => hold(escapeText(match)));
  text = text.replace(/\${3}([\s\S]+?)\${3}/g, (match) => hold(escapeText(match)));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match) => hold(escapeText(match)));
  text = text.replace(/(?<![\\$])\$([^$\n]+?)\$/g, (_match, body: string) =>
    hold(escapeText(`$${body}$`)),
  );

  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_match, url: string) =>
    hold(`<a href="${escapeAttribute(url)}">${escapeText(url)}</a>`),
  );
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, (match) => hold(match));

  text = text.replace(
    /!\[([^\]]*)\]\(\s*([^\s)>]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (_match, alt: string, url: string) =>
      hold(`<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}">`),
  );
  text = text.replace(
    /\[([^\]]+)\]\(\s*([^\s)>]+)(?:\s+["'][^"']*["'])?\s*\)/g,
    (_match, label: string, url: string) =>
      hold(`<a href="${escapeAttribute(url)}">${renderInline(label)}</a>`),
  );

  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, (_match, char: string) => hold(escapeText(char)));

  text = escapeText(text);

  text = text
    .replace(/\*\*(\S[\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(\S[\s\S]*?)__/g, '<strong>$1</strong>')
    .replace(/~~(\S[\s\S]*?)~~/g, '<del>$1</del>')
    .replace(/\*(\S[\s\S]*?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(\S[\s\S]*?)_(?!\w)/g, '$1<em>$2</em>');

  return restoreTokens(text, tokens);
}

function restoreTokens(text: string, tokens: string[]): string {
  let html = text;
  for (let pass = 0; pass < 8 && html.includes('\u0000'); pass++) {
    html = html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? '');
  }
  return html;
}
