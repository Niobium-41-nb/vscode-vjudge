import * as path from 'path';
import { ProblemRef } from './api/types';

const MAX_PART_LENGTH = 64;
const INVALID_PART = /[\s\\/:*?"<>|]/;

function usableOj(value: string): boolean {
  return (
    value.length <= MAX_PART_LENGTH &&
    /[A-Za-z\u3400-\u9fff]/.test(value) &&
    !INVALID_PART.test(value)
  );
}

function usableProbNum(value: string): boolean {
  return (
    value.length <= MAX_PART_LENGTH &&
    /[A-Za-z0-9\u3400-\u9fff]/.test(value) &&
    !INVALID_PART.test(value)
  );
}

function knownOjMap(knownOjs?: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  if (!knownOjs) {
    return map;
  }
  for (const raw of knownOjs) {
    const name = raw.trim();
    const key = safeNameKey(name);
    if (key && !map.has(key)) {
      map.set(key, name);
    }
  }
  return map;
}

function safeNameKey(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
}

function stripExtension(fileName: string): string {
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function parseBaseName(base: string, known: Map<string, string>): ProblemRef | undefined {
  const value = base.trim();
  if (!value || value.startsWith('.')) {
    return undefined;
  }
  const parts = value.split('-');
  if (parts.length < 2) {
    return undefined;
  }
  const candidates: ProblemRef[] = [];
  for (let split = 1; split < parts.length; split++) {
    const oj = parts.slice(0, split).join('-');
    const probNum = parts.slice(split).join('-');
    if (usableOj(oj) && usableProbNum(probNum)) {
      candidates.push({ oj, probNum });
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  const matched = candidates.find((ref) => known.has(safeNameKey(ref.oj)));
  if (matched) {
    const name = known.get(safeNameKey(matched.oj));
    return name ? { oj: name, probNum: matched.probNum } : matched;
  }
  return candidates[0];
}

export function problemRefFromPath(
  fsPath: string,
  knownOjs?: Iterable<string>,
): ProblemRef | undefined {
  const known = knownOjMap(knownOjs);
  const fileName = path.basename(fsPath);
  const base = stripExtension(fileName);
  const direct = parseBaseName(base, known);
  if (direct) {
    return direct;
  }
  if (!/^main$/i.test(base)) {
    return undefined;
  }
  // Java 题号在上一级目录（OJ-题号/Main.java），目录名易混淆，仅在 OJ 已知时采用
  const parent = path.basename(path.dirname(fsPath));
  const fromParent = parseBaseName(parent, known);
  if (!fromParent || !known.has(safeNameKey(fromParent.oj))) {
    return undefined;
  }
  return fromParent;
}