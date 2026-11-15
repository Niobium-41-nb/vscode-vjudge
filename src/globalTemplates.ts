import * as vscode from 'vscode';
import { builtinTemplateFiles, BuiltinTemplateFile } from './templates';

const TEMPLATE_FOLDER = 'templates';

export function globalTemplatesDirectory(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, TEMPLATE_FOLDER);
}

function normalizeExtension(extension: string): string | undefined {
  const value = extension.trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9_+-]{1,16}$/.test(value) ? value : undefined;
}

export function globalTemplateFile(
  context: vscode.ExtensionContext,
  extension: string,
): { uri: vscode.Uri; fileName: string } | undefined {
  const normalized = normalizeExtension(extension);
  if (!normalized) {
    return undefined;
  }
  const known = builtinTemplateFiles().find((file) => file.extension === normalized);
  const fileName = known?.fileName ?? `main.${normalized}`;
  return { uri: vscode.Uri.joinPath(globalTemplatesDirectory(context), fileName), fileName };
}

let ensurePromise: Promise<BuiltinTemplateFile[]> | undefined;

export function ensureGlobalTemplates(
  context: vscode.ExtensionContext,
  force = false,
): Promise<BuiltinTemplateFile[]> {
  if (!ensurePromise || force) {
    ensurePromise = createMissingTemplates(context).catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  return ensurePromise;
}

async function createMissingTemplates(context: vscode.ExtensionContext): Promise<BuiltinTemplateFile[]> {
  const directory = globalTemplatesDirectory(context);
  await vscode.workspace.fs.createDirectory(directory);
  const created: BuiltinTemplateFile[] = [];
  for (const file of builtinTemplateFiles()) {
    const uri = vscode.Uri.joinPath(directory, file.fileName);
    try {
      await vscode.workspace.fs.stat(uri);
      continue;
    } catch {
      // 文件不存在时写入内置模板
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
    created.push(file);
  }
  return created;
}
