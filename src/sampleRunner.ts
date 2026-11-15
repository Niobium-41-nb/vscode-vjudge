import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProblemRef, Sample } from './api/types';
import { problemFile } from './problemFiles';
import { describeError, Session } from './session';
import { fetchStatement } from './statementCache';
import { getConfiguration } from './utils';

const OUTPUT_LIMIT = 1024 * 1024;

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  duration: number;
  error?: string;
}

function quoteArgument(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function execute(command: string, cwd: string, input: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        duration: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (result: ExecResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) {
        stderr += chunk.toString('utf8');
      }
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (error) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        duration: Date.now() - startedAt,
        error: error.message,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        duration: Date.now() - startedAt,
      });
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
}

function renderBlock(text: string, empty = '(空)'): string {
  const value = text.replace(/\r\n?/g, '\n');
  return value.trim() ? value : empty;
}

async function resolveEditor(ref: ProblemRef): Promise<vscode.TextEditor | undefined> {
  const remembered = problemFile(ref);
  if (remembered) {
    const document = vscode.workspace.textDocuments.find(
      (item) => item.uri.toString() === remembered.toString(),
    );
    if (document) {
      const editor = vscode.window.visibleTextEditors.find(
        (item) => item.document === document,
      );
      if (editor) {
        return editor;
      }
    }
    try {
      return await vscode.window.showTextDocument(remembered, { preview: false });
    } catch {
      // 文件可能已被删除或移动
    }
  }
  return vscode.window.activeTextEditor;
}

export interface ImportedSampleSet {
  label: string;
  sourcePath: string;
  samples: Sample[];
}

async function getTestCommand(filePath: string): Promise<string | undefined> {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const commands = getConfiguration<Record<string, string>>('testCommands', {});
  const commandTemplate = commands[extension];
  if (commandTemplate) {
    return commandTemplate;
  }
  const choice = await vscode.window.showWarningMessage(
    `尚未配置 .${extension} 文件的运行命令，无法测试样例。`,
    '打开设置',
  );
  if (choice === '打开设置') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'vjudge.testCommands',
    );
  }
  return undefined;
}

async function executeSampleCases(
  output: vscode.OutputChannel,
  filePath: string,
  label: string,
  samples: Sample[],
  commandTemplate: string,
): Promise<void> {
  const timeoutMs = Math.max(1, getConfiguration('testTimeout', 10)) * 1000;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vjudge-tests-'));
  const executable = path.join(tempDir, process.platform === 'win32' ? 'main.exe' : 'main');
  const sourceDir = path.dirname(filePath);

  output.show(true);
  output.appendLine('');
  output.appendLine(`══════ 测试 ${label} · ${path.basename(filePath)} ══════`);

  let passedCount = 0;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '测试样例',
        cancellable: false,
      },
      async (progress) => {
        for (let index = 0; index < samples.length; index++) {
          const sample = samples[index];
          progress.report({
            message: `样例 ${index + 1}/${samples.length}`,
            increment: 100 / samples.length,
          });
          const inputPath = path.join(tempDir, `case-${index + 1}.in`);
          const outputPath = path.join(tempDir, `case-${index + 1}.out`);
          await fs.writeFile(inputPath, sample.input, 'utf8');
          const command = commandTemplate
            .replace(/\{file\}/g, quoteArgument(filePath))
            .replace(/\{dir\}/g, quoteArgument(sourceDir))
            .replace(/\{exe\}/g, quoteArgument(executable))
            .replace(/\{in\}/g, quoteArgument(inputPath))
            .replace(/\{out\}/g, quoteArgument(outputPath));

          output.appendLine('');
          output.appendLine(`—— 样例 ${index + 1} ——`);
          const result = await execute(command, sourceDir, sample.input, timeoutMs);
          const actual = normalizeOutput(result.stdout);
          const expected = normalizeOutput(sample.output);
          const passed =
            !result.timedOut &&
            !result.error &&
            result.exitCode === 0 &&
            actual === expected;

          if (passed) {
            passedCount++;
            output.appendLine(
              `通过（${result.duration} ms）`,
            );
            continue;
          }

          if (result.timedOut) {
            output.appendLine(`失败：运行超时（${timeoutMs / 1000} 秒）`);
          } else if (result.error) {
            output.appendLine(`失败：${result.error}`);
          } else if (result.exitCode !== 0) {
            output.appendLine(`失败：进程退出码 ${result.exitCode}`);
          } else {
            output.appendLine('失败：输出不一致');
          }
          output.appendLine('输入：');
          output.appendLine(renderBlock(sample.input));
          output.appendLine('期望输出：');
          output.appendLine(renderBlock(expected));
          output.appendLine('实际输出：');
          output.appendLine(renderBlock(actual));
          if (result.stderr.trim()) {
            output.appendLine('标准错误：');
            output.appendLine(result.stderr.trim());
          }
        }
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  output.appendLine('');
  output.appendLine(`结果：通过 ${passedCount} / ${samples.length}`);
  if (passedCount === samples.length) {
    void vscode.window.showInformationMessage(
      `样例全部通过（${passedCount}/${samples.length}）。`,
    );
  } else {
    const choice = await vscode.window.showWarningMessage(
      `样例通过 ${passedCount}/${samples.length}。`,
      '查看输出',
    );
    if (choice === '查看输出') {
      output.show(true);
    }
  }
}

export async function runSamples(
  session: Session,
  ref: ProblemRef,
  output: vscode.OutputChannel,
): Promise<void> {
  await session.ensureLoggedIn();
  const editor = await resolveEditor(ref);
  if (!editor || editor.document.uri.scheme === 'untitled') {
    void vscode.window.showWarningMessage(
      '请先打开该题目的代码文件。可以使用题面工具栏中的“新建代码文件”。',
    );
    return;
  }

  const filePath = editor.document.uri.fsPath;
  if (editor.document.isDirty) {
    await editor.document.save();
  }

  const commandTemplate = await getTestCommand(filePath);
  if (!commandTemplate) {
    return;
  }

  let samples: Sample[];
  try {
    const statement = await fetchStatement(session, ref);
    samples = statement.samples;
  } catch (error) {
    void vscode.window.showErrorMessage(`获取样例失败：${describeError(error)}`);
    return;
  }
  if (samples.length === 0) {
    void vscode.window.showInformationMessage('该题面没有可用的样例。');
    return;
  }

  await executeSampleCases(output, filePath, `${ref.oj}-${ref.probNum}`, samples, commandTemplate);
}

export async function runImportedSamples(
  input: ImportedSampleSet,
  output: vscode.OutputChannel,
): Promise<void> {
  if (input.samples.length === 0) {
    void vscode.window.showInformationMessage('该 CPH 题目没有测试数据。');
    return;
  }
  const uri = vscode.Uri.file(input.sourcePath);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(`CPH 记录的源文件不存在：${input.sourcePath}`);
    return;
  }

  let editor = vscode.window.visibleTextEditors.find(
    (item) => item.document.uri.toString() === uri.toString(),
  );
  if (!editor) {
    try {
      editor = await vscode.window.showTextDocument(uri, { preview: false });
    } catch {
      // 文件可能无权限打开
    }
  }
  if (!editor) {
    void vscode.window.showWarningMessage(`无法打开 CPH 记录的源文件：${input.sourcePath}`);
    return;
  }
  if (editor.document.isDirty) {
    await editor.document.save();
  }

  const filePath = editor.document.uri.fsPath;
  const commandTemplate = await getTestCommand(filePath);
  if (!commandTemplate) {
    return;
  }
  await executeSampleCases(output, filePath, input.label, input.samples, commandTemplate);
}
