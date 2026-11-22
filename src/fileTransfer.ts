import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { safeFileBase } from './templates';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;

interface Cancellation {
  cancelled: boolean;
}

interface BinaryResponse {
  body: Buffer;
  contentType: string;
}

interface FetchOptions {
  signal: Cancellation;
  onProgress?: (received: number, total?: number) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fetchBinary(url: string, options: FetchOptions, redirects = 0): Promise<BinaryResponse> {
  return new Promise<BinaryResponse>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('文件链接无效。'));
      return;
    }
    if (target.protocol !== 'https:') {
      reject(new Error('仅支持通过 HTTPS 下载文件。'));
      return;
    }

    const request = https.get(
      target,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        timeout: DOWNLOAD_TIMEOUT_MS,
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects >= 3) {
            reject(new Error('文件链接重定向次数过多。'));
            return;
          }
          let next: string;
          try {
            next = new URL(location, target).toString();
          } catch {
            reject(new Error('文件链接重定向地址无效。'));
            return;
          }
          fetchBinary(next, options, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`下载失败：HTTP ${status}。`));
          return;
        }

        const totalHeader = Number(response.headers['content-length'] ?? 0);
        const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          if (options.signal.cancelled) {
            response.destroy();
            reject(new Error('已取消下载。'));
            return;
          }
          received += chunk.length;
          if (received > MAX_FILE_BYTES) {
            response.destroy();
            reject(new Error('文件超过 50 MB，已取消下载。'));
            return;
          }
          chunks.push(chunk);
          options.onProgress?.(received, total);
        });
        response.on('end', () => {
          if (options.signal.cancelled) {
            reject(new Error('已取消下载。'));
            return;
          }
          resolve({ body: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? '') });
        });
        response.on('error', reject);
      },
    );

    request.on('timeout', () => request.destroy(new Error('下载超时。')));
    request.on('error', reject);
  });
}

function downloadFileName(input: string): string {
  const trimmed = (input || '').trim();
  const match = trimmed.match(/\.([A-Za-z0-9]{1,8})$/);
  const extension = match ? `.${match[1].toLowerCase()}` : '.pdf';
  const base = safeFileBase(match ? trimmed.slice(0, -match[0].length) : trimmed, 'attachment');
  return `${base}${extension}`;
}

export async function downloadStatementFile(url: string, suggestedName: string): Promise<void> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error('文件链接无效。');
  }
  if (target.protocol !== 'https:') {
    throw new Error('仅支持通过 HTTPS 下载文件。');
  }

  const fileName = downloadFileName(suggestedName);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const defaultUri = folder
    ? vscode.Uri.joinPath(folder.uri, fileName)
    : vscode.Uri.file(path.join(os.homedir(), fileName));
  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: '保存文件',
    filters: { 'PDF 文件': ['pdf'], '所有文件': ['*'] },
  });
  if (!saveUri) {
    return;
  }

  const cancellation: Cancellation = { cancelled: false };
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在下载 ${path.basename(saveUri.fsPath)}`,
        cancellable: true,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => {
          cancellation.cancelled = true;
        });
        let reported = 0;
        const response = await fetchBinary(url, {
          signal: cancellation,
          onProgress: (received, total) => {
            if (total) {
              const percent = Math.min(100, Math.floor((received / total) * 100));
              progress.report({ increment: Math.max(0, percent - reported), message: `${formatBytes(received)} / ${formatBytes(total)}` });
              reported = percent;
            } else {
              progress.report({ message: formatBytes(received) });
            }
          },
        });
        if (cancellation.cancelled) {
          throw new Error('已取消下载。');
        }
        if (/^text\/html/i.test(response.contentType)) {
          throw new Error('服务器返回了网页而不是文件，请确认链接有效。');
        }
        await vscode.workspace.fs.writeFile(saveUri, response.body);
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === '已取消下载。') {
      return;
    }
    throw error;
  }

  const action = await vscode.window.showInformationMessage(`文件已下载：${saveUri.fsPath}`, '在文件管理器中显示');
  if (action) {
    await vscode.commands.executeCommand('revealFileInOS', saveUri);
  }
}
