import {
  ContestDetail,
  ContestProblem,
  DescriptionBrief,
  DescriptionRef,
  ProblemDetail,
  ProblemProperty,
  ProblemRef,
  Sample,
  Statement,
  WorkbookDetail,
} from './types';
import { isMarkdownFormat, renderMarkdown } from './markdown';

export function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _match;
      }
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _match;
      }
    })
    .replace(/&amp;/g, '&');
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripTags(input: string): string {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|dt|dd|pre)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  );
}

export function cleanText(input: string): string {
  return stripTags(input).replace(/\s+/g, ' ').trim();
}

function normalizeSampleText(input: string): string {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

function collectPreText(html: string): string[] {
  const pres: string[] = [];
  const regex = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const text = normalizeSampleText(match[1]);
    if (text) {
      pres.push(text);
    }
  }
  if (pres.length > 0) {
    return pres;
  }
  const fallback = normalizeSampleText(html);
  return fallback ? [fallback] : [];
}

function dedupeSamples(samples: Sample[]): Sample[] {
  const seen = new Set<string>();
  const result: Sample[] = [];
  for (const sample of samples) {
    const key = `${sample.input}\u0000${sample.output}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(sample);
  }
  return result;
}

function pairSamples(inputs: string[], outputs: string[]): Sample[] {
  const size = Math.min(inputs.length, outputs.length);
  const result: Sample[] = [];
  for (let i = 0; i < size; i++) {
    result.push({ input: inputs[i], output: outputs[i] });
  }
  return result;
}

function isInputLabel(label: string): boolean {
  const text = label.toLowerCase();
  if (/output|输出/.test(text)) {
    return false;
  }
  return /sample\s*input/.test(text) || /^输入/.test(text) || /^input(\s*#?\s*\d+)?$/.test(text);
}

function isOutputLabel(label: string): boolean {
  const text = label.toLowerCase();
  return /sample\s*output/.test(text) || /^输出/.test(text) || /^output(\s*#?\s*\d+)?$/.test(text);
}

function extractFromTables(html: string): Sample[] {
  const samples: Sample[] = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(html))) {
    const tableHtml = tableMatch[0];
    const inner = tableMatch[1];
    if (!/vjudge_sample|sample[-_ ]?test/i.test(tableHtml)) {
      continue;
    }

    const headerCells = Array.from(inner.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)).map((m) =>
      cleanText(m[1]).toLowerCase(),
    );
    let inputIndex = headerCells.findIndex((header) => /input|输入/.test(header));
    let outputIndex = headerCells.findIndex((header) => /output|输出/.test(header));
    if (inputIndex < 0 && outputIndex < 0) {
      inputIndex = 0;
      outputIndex = 1;
    } else {
      if (inputIndex < 0) {
        inputIndex = 0;
      }
      if (outputIndex < 0) {
        outputIndex = inputIndex + 1;
      }
    }

    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRegex.exec(inner))) {
      const rowHtml = rowMatch[1];
      if (/<th\b/i.test(rowHtml)) {
        continue;
      }
      const cells = Array.from(rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1]);
      if (cells.length <= Math.max(inputIndex, outputIndex)) {
        continue;
      }
      const inputTexts = collectPreText(cells[inputIndex]);
      const outputTexts = collectPreText(cells[outputIndex]);
      if (inputTexts.length > 0 && outputTexts.length > 0) {
        samples.push(...pairSamples(inputTexts, outputTexts));
      }
    }
  }
  return samples;
}

function extractFromInputOutputDivs(html: string): Sample[] {
  const samples: Sample[] = [];
  const regex =
    /<div[^>]*class=["'][^"']*\b(input|output)(?=[\s"'])[^"']*["'][^>]*>[\s\S]{0,1200}?<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let pendingInput: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const kind = match[1].toLowerCase();
    const text = normalizeSampleText(match[2]);
    if (!text) {
      continue;
    }
    if (kind === 'input') {
      pendingInput = text;
    } else if (pendingInput !== undefined) {
      samples.push({ input: pendingInput, output: text });
      pendingInput = undefined;
    }
  }
  return samples;
}

function extractFromDefinitionLists(html: string): Sample[] {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const regex = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const label = cleanText(match[1]);
    const texts = collectPreText(match[2]);
    if (texts.length === 0) {
      continue;
    }
    if (isInputLabel(label)) {
      inputs.push(...texts);
    } else if (isOutputLabel(label)) {
      outputs.push(...texts);
    }
  }
  return pairSamples(inputs, outputs);
}

function extractFromHeadings(html: string): Sample[] {
  const inputs: string[] = [];
  const outputs: string[] = [];
  const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>([\s\S]{0,4000}?)<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const label = cleanText(match[2]);
    const text = normalizeSampleText(match[4]);
    if (!text) {
      continue;
    }
    if (isInputLabel(label)) {
      inputs.push(text);
    } else if (isOutputLabel(label)) {
      outputs.push(text);
    }
  }
  return pairSamples(inputs, outputs);
}

export function extractSamples(html: string): Sample[] {
  let samples = extractFromTables(html);
  if (samples.length === 0) {
    samples = extractFromInputOutputDivs(html);
  }
  if (samples.length === 0) {
    samples = extractFromDefinitionLists(html);
  }
  if (samples.length === 0) {
    samples = extractFromHeadings(html);
  }
  return dedupeSamples(samples);
}

export function extractTextareaJson<T>(
  html: string,
  predicate: (value: unknown) => boolean,
): T | undefined {
  return extractTextareaJsonValues(html).find(predicate) as T | undefined;
}

function extractTextareaJsonValues(html: string): unknown[] {
  const values: unknown[] = [];
  const regex = /<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const raw = match[1].trim();
    if (!raw) {
      continue;
    }
    const candidates = raw.includes('&') ? [raw, decodeEntities(raw)] : [raw];
    for (const candidate of candidates) {
      try {
        values.push(JSON.parse(candidate));
        break;
      } catch {
        // 继续尝试其他 textarea / 解码结果
      }
    }
  }
  return values;
}

export function extractPageTitle(html: string): string {
  const patterns = [
    /<h2\b[^>]*id=["']prob-title["'][^>]*>([\s\S]*?)<\/h2>/i,
    /<div\b[^>]*id=["']prob-title["'][^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
    /<h2\b[^>]*class=["'][^"']*problem[-_ ]?title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const title = cleanText(match[1]);
      if (title) {
        return title;
      }
    }
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return cleanText(titleMatch[1]).replace(/\s*-\s*Virtual Judge\s*$/i, '');
  }
  return '';
}

export function normalizeLanguages(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        result[item] = item;
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const code = String(record.id ?? record.key ?? record.code ?? record.name ?? '');
        const name = String(record.name ?? record.displayName ?? record.id ?? record.code ?? code);
        if (code) {
          result[code] = name;
        }
      }
    }
    return result;
  }
  if (typeof value === 'object') {
    for (const [code, name] of Object.entries(value as Record<string, unknown>)) {
      if (typeof name === 'string' || typeof name === 'number') {
        result[code] = String(name);
      } else if (name && typeof name === 'object') {
        const record = name as Record<string, unknown>;
        result[code] = String(record.name ?? record.displayName ?? code);
      }
    }
  }
  return result;
}

type DescriptionExtra = Pick<
  DescriptionRef,
  'author' | 'official' | 'lang' | 'langDisplay' | 'type' | 'updateDate' | 'remarks'
>;

function parseDescriptions(html: string, jsonDocs: unknown[] = []): DescriptionRef[] {
  const refs = new Map<number, DescriptionRef>();
  const add = (
    idValue: unknown,
    versionValue: unknown,
    extra: DescriptionExtra = {},
  ): void => {
    const id = Number(idValue);
    if (!Number.isFinite(id) || id <= 0) {
      return;
    }
    const version = Number(versionValue);
    const safeVersion = Number.isFinite(version) && version > 0 ? version : 0;
    const existing = refs.get(id);
    if (existing) {
      if (safeVersion > existing.version) {
        existing.version = safeVersion;
      }
      for (const key of [
        'author',
        'lang',
        'langDisplay',
        'type',
        'updateDate',
        'remarks',
      ] as const) {
        if (!existing[key] && extra[key]) {
          existing[key] = extra[key];
        }
      }
      existing.official = existing.official || extra.official;
      return;
    }
    refs.set(id, { id, version: safeVersion, ...extra });
  };

  for (const doc of jsonDocs) {
    collectJsonDescriptionRefs(doc, add);
  }
  if (refs.size === 0) {
    for (const doc of jsonDocs) {
      collectEnabledDescriptionKeys(doc, add);
    }
  }

  const start = html.search(/id=["']prob-descs["']/i);
  const source = start >= 0 ? html.slice(start) : html;
  const tagRegex = /<[a-zA-Z][\w:-]*\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(source))) {
    const tag = match[0];
    const keyAttribute = tag.match(/\b(data-(?:description-)?key)\s*=/i);
    if (!keyAttribute) {
      continue;
    }
    const versionAttribute = tag.match(/\bdata-(?:description-)?version(?=\s*=)/i);
    add(
      readAttribute(tag, keyAttribute[1]),
      versionAttribute ? readAttribute(tag, versionAttribute[0]) : 0,
      {
        author: readAttribute(tag, 'data-author') || undefined,
        lang: readAttribute(tag, 'data-lang') || undefined,
        langDisplay: readAttribute(tag, 'data-lang-display') || undefined,
        type: readAttribute(tag, 'data-type') || undefined,
        updateDate: readAttribute(tag, 'data-update-date') || undefined,
        official: /\bdata-official(?:="?true"?)?/i.test(tag) || undefined,
      },
    );
  }

  // 新页面把题面列表放在 JSON 中由脚本渲染，静态 HTML 里也可能保留 iframe 或链接。
  const iframeRegex = /<iframe\b[^>]*>/gi;
  while ((match = iframeRegex.exec(html))) {
    const tag = match[0];
    for (const attribute of ['src', 'data-src', 'data-url']) {
      const url = readAttribute(tag, attribute);
      const parsed = /\/problem\/description\/(\d+)(?:\?(\d+))?/.exec(url);
      if (parsed) {
        add(parsed[1], parsed[2] ?? 0);
      }
    }
  }

  if (refs.size === 0) {
    const urlRegex = /\/problem\/description\/(\d+)(?:\?(\d+))?/gi;
    while ((match = urlRegex.exec(html))) {
      add(match[1], match[2] ?? 0);
    }
  }

  const rank = (item: DescriptionRef): number =>
    Number(Boolean(item.official)) * 2 + (item.lang?.toLowerCase() === 'en' ? 1 : 0);
  return [...refs.values()].sort((left, right) => rank(right) - rank(left));
}

type DescriptionAdd = (
  id: unknown,
  version: unknown,
  extra?: DescriptionExtra,
) => void;

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function collectEnabledDescriptionKeys(value: unknown, add: DescriptionAdd): void {
  const visit = (node: unknown, parentKey: string, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      if (/^enabledDescKeys$/i.test(parentKey)) {
        for (const item of node) {
          if (typeof item === 'number' || typeof item === 'string') {
            add(item, 0);
          }
        }
      }
      for (const item of node) {
        visit(item, parentKey, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, key, depth + 1);
    }
  };
  visit(value, '', 0);
}

function collectJsonDescriptionRefs(value: unknown, add: DescriptionAdd): void {
  const visit = (node: unknown, parentKey: string, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      if (/desc|statement|brief/i.test(parentKey) && !/enabled/i.test(parentKey)) {
        for (const item of node) {
          if (typeof item === 'number' || typeof item === 'string') {
            add(item, 0);
          } else if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            add(
              record.key ??
                record.descriptionKey ??
                record.descKey ??
                record.id ??
                record.descriptionId,
              record.version ??
                record.descriptionVersion ??
                record.descVersion ??
                record.updateDate ??
                record.updateTime,
              {
                author: optionalText(record.author ?? record.authorName),
                official:
                  record.official === true ||
                  record.isOfficial === true ||
                  record.mainOfficial === true,
                lang: optionalText(record.lang ?? record.statementKey),
                langDisplay: optionalText(record.langDisplay),
                type: optionalText(record.type),
                updateDate: optionalText(record.updateDate),
                remarks: optionalText(record.remarks),
              },
            );
          }
        }
      }
      for (const item of node) {
        visit(item, parentKey, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      record.descriptionId !== undefined ||
      record.descId !== undefined ||
      record.descriptionKey !== undefined
    ) {
      add(
        record.descriptionId ?? record.descId ?? record.descriptionKey,
        record.descriptionVersion ?? record.descVersion ?? record.version,
      );
    }
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string') {
        const match = /\/problem\/description\/(\d+)(?:\?(\d+))?/.exec(child);
        if (match) {
          add(match[1], match[2] ?? 0);
        }
      }
      if (/desc|statement|brief/i.test(key) || (child !== null && typeof child === 'object')) {
        visit(child, key, depth + 1);
      }
    }
  };
  visit(value, '', 0);
}

function readAttribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'),
  );
  if (!match) {
    return '';
  }
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

export function parseContestDetail(html: string): ContestDetail {
  const data = extractTextareaJson<Record<string, unknown>>(
    html,
    (value) => !!value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).problems),
  );
  if (!data) {
    throw new Error('无法解析比赛信息，可能需要登录或没有访问权限。');
  }
  const problemsRaw = Array.isArray(data.problems) ? (data.problems as Record<string, unknown>[]) : [];
  const problems: ContestProblem[] = problemsRaw.map((problem) => ({
    pid: Number(problem.pid ?? 0),
    oj: String(problem.oj ?? ''),
    probNum: String(problem.probNum ?? ''),
    num: String(problem.num ?? ''),
    title: String(problem.title ?? ''),
    languages: normalizeLanguages(problem.languages),
    enabledDescKeys: Array.isArray(problem.enabledDescKeys)
      ? (problem.enabledDescKeys as unknown[]).map((key) => Number(key)).filter((key) => Number.isFinite(key))
      : undefined,
    descBriefs: Array.isArray(problem.descBriefs)
      ? (problem.descBriefs as DescriptionBrief[]).filter((brief) => !!brief && Number.isFinite(Number(brief.key)))
      : undefined,
    properties: Array.isArray(problem.properties) ? (problem.properties as ProblemProperty[]) : undefined,
    weight: Number(problem.weight ?? 1),
  }));

  return {
    id: Number(data.id ?? 0),
    title: String(data.title ?? ''),
    type: Number(data.type ?? 0),
    openness: Number(data.openness ?? 0),
    authStatus: Number(data.authStatus ?? 0),
    begin: Number(data.begin ?? 0),
    end: Number(data.end ?? 0),
    managerName: typeof data.managerName === 'string' ? data.managerName : undefined,
    problems,
  };
}

export function parseProblemDetail(html: string, oj: string, probNum: string): ProblemDetail {
  const jsonDocs = extractTextareaJsonValues(html);
  const isProblemJson = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      record.languages !== undefined ||
      record.problemId !== undefined ||
      record.descBriefs !== undefined ||
      record.descriptionId !== undefined
    );
  };
  const data = (jsonDocs.find(isProblemJson) as Record<string, unknown> | undefined) ?? {};

  const title = extractPageTitle(html) || String(data.title ?? '');
  const languages = normalizeLanguages(data.languages);
  const descriptions = parseDescriptions(html, jsonDocs);

  return {
    oj,
    probNum,
    title,
    problemId: data.problemId !== undefined ? Number(data.problemId) : undefined,
    languages,
    descriptions,
    accepted: data.accepted === true,
    attempted: data.attempted === true,
    allowSubmit: data.allowSubmit !== false,
    status: data.status !== undefined ? Number(data.status) : undefined,
    properties: Array.isArray(data.properties) ? (data.properties as ProblemProperty[]) : undefined,
  };
}

function parseProblemsBrief(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function workbookProblemKeys(content: string, briefs: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[problem:([^\]\s]+)\]/g)) {
    const key = match[1];
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  for (const key of Object.keys(briefs)) {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function parseWorkbookDetail(html: string): WorkbookDetail {
  const data = extractTextareaJson<Record<string, unknown>>(
    html,
    (value) => {
      if (!value || typeof value !== 'object') {
        return false;
      }
      const record = value as Record<string, unknown>;
      return typeof record.isWorkbook === 'boolean' || !!record.workbook;
    },
  );
  if (!data) {
    throw new Error('无法解析题单信息，可能需要登录或没有访问权限。');
  }
  if (data.isWorkbook !== true) {
    throw new Error('该链接不是 VJudge 题单。');
  }
  const workbook =
    data.workbook && typeof data.workbook === 'object'
      ? (data.workbook as Record<string, unknown>)
      : {};
  const briefs = parseProblemsBrief(workbook.problemsBrief);
  const content = typeof data.content === 'string' ? data.content : '';
  const problems: ProblemRef[] = [];
  for (const key of workbookProblemKeys(content, briefs)) {
    const dash = key.indexOf('-');
    if (dash <= 0 || dash >= key.length - 1) {
      continue;
    }
    const brief = briefs[key];
    let title = '';
    let source = '';
    if (Array.isArray(brief)) {
      title = cleanText(String(brief[0] ?? ''));
      source = cleanText(String(brief[2] ?? ''));
    } else if (brief && typeof brief === 'object') {
      const record = brief as Record<string, unknown>;
      title = cleanText(String(record.title ?? ''));
      source = cleanText(String(record.source ?? ''));
    }
    problems.push({
      oj: key.slice(0, dash),
      probNum: key.slice(dash + 1),
      title,
      source: source || undefined,
    });
  }

  return {
    id: Number(data.id ?? 0),
    title: cleanText(String(data.title ?? '')),
    author: String(data.author ?? ''),
    openness: Number(data.openness ?? 0),
    joined: workbook.joined === true,
    viewCnt: Number(data.viewCnt ?? 0),
    createTime: Number(data.createTime ?? 0),
    updateTime: Number(data.updateTime ?? 0),
    content,
    nodeId: Number(data.nodeId ?? 0),
    problems,
  };
}

interface DescriptionSection {
  title: string;
  html: string;
}

interface ParsedDescription {
  sections: DescriptionSection[];
  samples: Sample[];
}

export function parseDescriptionPage(html: string): ParsedDescription {
  const data = extractTextareaJson<Record<string, unknown>>(
    html,
    (value) => !!value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).sections),
  );

  if (data && Array.isArray(data.sections)) {
    const sections: DescriptionSection[] = [];
    for (const section of data.sections as Record<string, unknown>[]) {
      const title = cleanText(String(section.title ?? ''));
      const value = section.value as Record<string, unknown> | string | undefined;
      const content =
        typeof value === 'string'
          ? value
          : value && typeof value === 'object'
            ? String(value.content ?? '')
            : String(section.content ?? '');
      const format =
        value && typeof value === 'object' && typeof value.format === 'string'
          ? value.format
          : typeof section.format === 'string'
            ? section.format
            : '';
      if (content.trim()) {
        sections.push({ title, html: isMarkdownFormat(format) ? renderMarkdown(content) : content });
      }
    }
    if (sections.length > 0) {
      const joined = sections.map((section) => section.html).join('\n<hr class="vj-section-sep"/>\n');
      return { sections, samples: extractSamples(joined) };
    }
  }

  let content = '';
  const containerStart = html.search(/<div\b[^>]*id=["']description-container["']/i);
  if (containerStart >= 0) {
    const openEnd = html.indexOf('>', containerStart);
    if (openEnd >= 0) {
      content = html.slice(openEnd + 1);
    }
  }
  if (!content) {
    const bodyStart = html.search(/<body\b[^>]*>/i);
    content = bodyStart >= 0 ? html.slice(html.indexOf('>', bodyStart) + 1) : html;
  }
  content = content
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const footerIndex = content.search(/<div\b[^>]*class=["'][^"']*body-footer/i);
  if (footerIndex >= 0) {
    content = content.slice(0, footerIndex);
  }
  const bodyEnd = content.search(/<\/body>/i);
  if (bodyEnd >= 0) {
    content = content.slice(0, bodyEnd);
  }
  return {
    sections: content.trim() ? [{ title: '', html: content }] : [],
    samples: extractSamples(content),
  };
}

export function isChallengePage(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  if (/Just a moment|Attention Required!?\s*\|\s*Cloudflare|Checking your browser before accessing/i.test(title)) {
    return true;
  }
  return (
    (/id=["']challenge-form["']/i.test(html) && /cf-chl|challenge-platform/i.test(html)) ||
    /cf-browser-verification/i.test(html) ||
    /window\._cf_chl_opt/i.test(html) ||
    /Enable JavaScript and cookies to continue/i.test(html)
  );
}

const VJUDGE_CDN_BASE = 'https://cdn.vjudge.net.cn/';

export function sanitizeStatementHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>/gi, '<div>')
    .replace(/<\/form>/gi, '</div>')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\shref\s*=\s*(["'])javascript:[^"']*\1/gi, ' href="#"')
    .replace(/CDN_BASE_URL\//g, VJUDGE_CDN_BASE)
    .replace(/\s(src|href)\s*=\s*(["'])\/\/(?!\/)/gi, ' $1=$2https://')
    .replace(/\s(src|href)\s*=\s*(["'])\/(?!\/)/gi, ' $1=$2https://vjudge.net/')
    .replace(/\ssrcset\s*=\s*(["'])[^"']*\1/gi, '')
    .trim();
}

export function buildStatement(
  refOj: string,
  refProbNum: string,
  title: string,
  languages: Record<string, string>,
  descriptionHtml: string,
): Statement {
  return {
    oj: refOj,
    probNum: refProbNum,
    title,
    html: sanitizeStatementHtml(descriptionHtml),
    samples: extractSamples(descriptionHtml),
    languages,
  };
}
