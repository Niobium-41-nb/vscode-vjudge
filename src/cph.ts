import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProblemRef, Sample } from './api/types';
import {
  buildCphProblem,
  CphProblem,
  cphProbPath,
  cphProblemRef,
  parseCphProblem,
} from './cphFormat';

const STATE_KEY = 'vjudge.cphFiles';
const LINK_KEY = 'vjudge.cphSources';
const SCAN_TTL = 15_000;
const MAX_FILES = 2000;
const MAX_DIRECTORIES = 5000;
const MAX_PROBLEM_SIZE = 8 * 1024 * 1024;
const MAX_DEPTH = 8;
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
]);

export interface CphFileProblem extends CphProblem {
  probPath: string;
  mtimeMs: number;
}

interface ScanBudget {
  dirs: number;
  files: Set<string>;
}

function normalize(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameProblem(left: ProblemRef, right: ProblemRef): boolean {
  return (
    left.oj.toLowerCase() === right.oj.toLowerCase() &&
    left.probNum.toLowerCase() === right.probNum.toLowerCase()
  );
}

function isProbFile(name: string): boolean {
  return name.toLowerCase().endsWith('.prob');
}

async function readCphFile(probPath: string): Promise<CphFileProblem | undefined> {
  try {
    const stat = await fs.stat(probPath);
    if (!stat.isFile() || stat.size > MAX_PROBLEM_SIZE) {
      return undefined;
    }
    const text = await fs.readFile(probPath, 'utf8');
    const parsed = parseCphProblem(text);
    if (!parsed) {
      return undefined;
    }
    return { ...parsed, probPath, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

async function collectProbFiles(directory: string, budget: ScanBudget): Promise<void> {
  if (budget.dirs++ > MAX_DIRECTORIES || budget.files.size >= MAX_FILES) {
    return;
  }
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.files.size >= MAX_FILES) {
      return;
    }
    if (entry.isFile() && isProbFile(entry.name)) {
      budget.files.add(path.join(directory, entry.name));
    }
  }
}

async function walkWorkspace(directory: string, budget: ScanBudget, depth: number): Promise<void> {
  if (depth > MAX_DEPTH || budget.dirs++ > MAX_DIRECTORIES || budget.files.size >= MAX_FILES) {
    return;
  }
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === '.cph') {
      await collectProbFiles(path.join(directory, entry.name), budget);
      continue;
    }
    if (IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    await walkWorkspace(path.join(directory, entry.name), budget, depth + 1);
  }
}

function sourcePathFor(problem: CphFileProblem): string {
  if (!problem.srcPath) {
    return '';
  }
  if (path.isAbsolute(problem.srcPath)) {
    return problem.srcPath;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(problem.probPath));
  const base = folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return base ? path.resolve(base, problem.srcPath) : '';
}

export class CphStore {
  private scanCache: { at: number; problems: CphFileProblem[] } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private storedPaths(): string[] {
    const state = this.context.workspaceState;
    if (!state) {
      return [];
    }
    const stored = state.get<string[]>(STATE_KEY, []);
    return Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : [];
  }

  private links(): Record<string, string> {
    const state = this.context.workspaceState;
    const stored = state?.get<Record<string, string>>(LINK_KEY, {});
    const result: Record<string, string> = {};
    if (stored && typeof stored === 'object') {
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === 'string') {
          result[key] = value;
        }
      }
    }
    return result;
  }

  async linkSource(uri: vscode.Uri, probPath: string): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }
    const links = this.links();
    links[normalize(uri.fsPath)] = probPath;
    await this.context.workspaceState.update(LINK_KEY, links);
  }

  async remember(problems: CphFileProblem[]): Promise<void> {
    const merged = new Map<string, string>();
    for (const filePath of [...this.storedPaths(), ...problems.map((problem) => problem.probPath)]) {
      merged.set(normalize(filePath), filePath);
    }
    const state = this.context.workspaceState;
    if (state) {
      await state.update(STATE_KEY, Array.from(merged.values()));
    }
  }

  async scan(force = false): Promise<CphFileProblem[]> {
    if (!force && this.scanCache && Date.now() - this.scanCache.at < SCAN_TTL) {
      return this.scanCache.problems;
    }
    const budget: ScanBudget = { dirs: 0, files: new Set<string>() };
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === 'file') {
        await walkWorkspace(folder.uri.fsPath, budget, 0);
      }
    }
    const saveLocation = vscode.workspace
      .getConfiguration('cph')
      .get<string>('general.saveLocation', '')
      .trim();
    if (saveLocation) {
      await collectProbFiles(path.resolve(saveLocation), budget);
    }

    const problems: CphFileProblem[] = [];
    const seen = new Set<string>();
    for (const probPath of budget.files) {
      const key = normalize(probPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const problem = await readCphFile(probPath);
      if (problem) {
        problems.push(problem);
      }
    }
    problems.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    this.scanCache = { at: Date.now(), problems };
    return problems;
  }

  async findForRef(ref: ProblemRef): Promise<CphFileProblem[]> {
    const problems = await this.scan();
    return problems
      .filter((problem) => {
        const parsed = cphProblemRef(problem.url);
        return Boolean(parsed && sameProblem(parsed, ref));
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async saveSamples(
    ref: ProblemRef,
    sourceUri: vscode.Uri,
    samples: Sample[],
    name?: string,
  ): Promise<CphFileProblem | undefined> {
    if (sourceUri.scheme !== 'file') {
      return undefined;
    }
    const tests = samples.filter((sample) => sample.input.trim() || sample.output.trim());
    if (tests.length === 0) {
      return undefined;
    }
    const saveLocation = vscode.workspace
      .getConfiguration('cph')
      .get<string>('general.saveLocation', '');
    const probPath = cphProbPath(sourceUri.fsPath, saveLocation);
    const existing = await readCphFile(probPath);
    if (existing && existing.tests.length > 0) {
      return existing;
    }
    const text = buildCphProblem({
      name: name?.trim() || ref.title?.trim() || `${ref.oj}-${ref.probNum}`,
      url: `https://vjudge.net/problem/${encodeURIComponent(ref.oj)}-${encodeURIComponent(ref.probNum)}`,
      group: ref.source?.trim() || 'VJudge',
      tests,
      srcPath: sourceUri.fsPath,
      interactive: false,
    });
    try {
      await fs.mkdir(path.dirname(probPath), { recursive: true });
      await fs.writeFile(probPath, text, 'utf8');
    } catch {
      return undefined;
    }
    this.scanCache = undefined;
    return readCphFile(probPath);
  }

  async forSourceFile(uri: vscode.Uri, ref?: ProblemRef): Promise<CphFileProblem | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const target = normalize(uri.fsPath);
    const linked = this.links()[target];
    if (linked) {
      const problem = await readCphFile(linked);
      if (problem) {
        return problem;
      }
    }
    let best: CphFileProblem | undefined;
    for (const probPath of this.storedPaths()) {
      const problem = await readCphFile(probPath);
      if (!problem) {
        continue;
      }
      const sourcePath = sourcePathFor(problem);
      if (sourcePath && normalize(sourcePath) === target && (!best || problem.mtimeMs > best.mtimeMs)) {
        best = problem;
      }
    }
    if (best) {
      return best;
    }
    if (!ref) {
      return undefined;
    }
    return (await this.findForRef(ref))[0];
  }

  sourceUri(problem: CphFileProblem): vscode.Uri | undefined {
    const sourcePath = sourcePathFor(problem);
    return sourcePath ? vscode.Uri.file(sourcePath) : undefined;
  }
}
