import { createHash } from 'crypto';
import * as path from 'path';
import { ProblemRef, Sample } from './api/types';

export interface CphProblem {
  name: string;
  url: string;
  group: string;
  tests: Sample[];
  srcPath: string;
  interactive: boolean;
}

export interface CphSaveInput {
  name: string;
  url: string;
  group: string;
  tests: Sample[];
  srcPath: string;
  interactive: boolean;
  memoryLimit?: number;
  timeLimit?: number;
}

export function cphProbFileName(sourcePath: string): string {
  const digest = createHash('md5').update(sourcePath).digest('hex');
  return `.${path.basename(sourcePath)}_${digest}.prob`;
}

export function cphProbPath(sourcePath: string, saveLocation = ''): string {
  const configured = saveLocation.trim();
  const folder = configured
    ? path.resolve(configured)
    : path.join(path.dirname(sourcePath), '.cph');
  return path.join(folder, cphProbFileName(sourcePath));
}

export function buildCphProblem(input: CphSaveInput): string {
  return JSON.stringify({
    name: input.name,
    url: input.url,
    tests: input.tests.map((test, index) => ({
      id: index,
      input: test.input,
      output: test.output,
    })),
    interactive: input.interactive,
    memoryLimit: input.memoryLimit ?? 1024,
    timeLimit: input.timeLimit ?? 3000,
    srcPath: input.srcPath,
    group: input.group,
  });
}

export function parseCphProblem(text: string): CphProblem | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const tests: Sample[] = [];
  for (const item of Array.isArray(record.tests) ? record.tests : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const test = item as Record<string, unknown>;
    if (typeof test.input !== 'string') {
      continue;
    }
    tests.push({
      input: test.input,
      output: typeof test.output === 'string' ? test.output : '',
    });
  }
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name && tests.length === 0) {
    return undefined;
  }
  return {
    name: name || '(未命名题目)',
    url: typeof record.url === 'string' ? record.url.trim() : '',
    group: typeof record.group === 'string' ? record.group.trim() : '',
    tests,
    srcPath: typeof record.srcPath === 'string' ? record.srcPath.trim() : '',
    interactive: record.interactive === true,
  };
}

export function cphProblemRef(url: string): ProblemRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'vjudge.net' && host !== 'www.vjudge.net') {
    return undefined;
  }
  const match = parsed.pathname.match(/^\/problem\/([^/]+)-([^/]+)\/?$/);
  if (!match) {
    return undefined;
  }
  const oj = decodeURIComponent(match[1]).trim();
  const probNum = decodeURIComponent(match[2]).trim();
  if (!oj || !probNum) {
    return undefined;
  }
  return { oj, probNum };
}
