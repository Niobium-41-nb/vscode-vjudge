import * as vscode from 'vscode';
import { builtinHeaderFiles, BuiltinHeaderFile } from './templates';

const HEADER_FOLDER = 'headers';

export function globalHeadersDirectory(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, HEADER_FOLDER);
}

function normalizeExtension(extension: string): string | undefined {
  const value = extension.trim().replace(/^\./, '').toLowerCase();
  return /^[a-z0-9_+-]{1,16}$/.test(value) ? value : undefined;
}

export function globalHeaderFile(
  context: vscode.ExtensionContext,
  extension: string,
): { uri: vscode.Uri; fileName: string } | undefined {
  const normalized = normalizeExtension(extension);
  if (!normalized) {
    return undefined;
  }
  const fileName = `${normalized}.txt`;
  return { uri: vscode.Uri.joinPath(globalHeadersDirectory(context), fileName), fileName };
}

let ensurePromise: Promise<BuiltinHeaderFile[]> | undefined;

export function ensureGlobalHeaders(
  context: vscode.ExtensionContext,
  force = false,
): Promise<BuiltinHeaderFile[]> {
  if (!ensurePromise || force) {
    ensurePromise = createMissingHeaders(context).catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  return ensurePromise;
}

async function createMissingHeaders(context: vscode.ExtensionContext): Promise<BuiltinHeaderFile[]> {
  const directory = globalHeadersDirectory(context);
  await vscode.workspace.fs.createDirectory(directory);
  const created: BuiltinHeaderFile[] = [];
  for (const file of builtinHeaderFiles()) {
    const uri = vscode.Uri.joinPath(directory, file.fileName);
    try {
      await vscode.workspace.fs.stat(uri);
      continue;
    } catch {
      // 文件不存在时写入内置头文件
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'utf8'));
    created.push(file);
  }
  return created;
}
