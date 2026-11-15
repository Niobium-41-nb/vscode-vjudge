import * as vscode from 'vscode';

export function formatDateTime(value: number | undefined): string {
  if (!value) {
    return '未知';
  }
  const date = new Date(value < 100000000000 ? value * 1000 : value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatRelativeTime(value: number | undefined): string {
  if (!value) {
    return '';
  }
  const date = new Date(value < 100000000000 ? value * 1000 : value).getTime();
  const diff = Date.now() - date;
  if (diff < 60000) {
    return '刚刚';
  }
  if (diff < 3600000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  }
  if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)} 小时前`;
  }
  return formatDateTime(value);
}

export function formatMemory(kilobytes: number | undefined): string {
  if (!kilobytes || kilobytes <= 0) {
    return '0 KB';
  }
  if (kilobytes < 1024) {
    return `${kilobytes} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

export function formatRuntime(milliseconds: number | undefined): string {
  if (!milliseconds || milliseconds <= 0) {
    return '0 ms';
  }
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function contestTypeLabel(type: number): string {
  switch (type) {
    case 0:
      return '标准比赛';
    case 1:
      return '练习';
    case 2:
      return '回放';
    default:
      return '比赛';
  }
}

export function workbookOpennessLabel(openness: number): string {
  switch (openness) {
    case 0:
      return '私密';
    case 1:
      return '不公开';
    case 2:
      return '公开';
    default:
      return '未知';
  }
}

export function statusIcon(
  extensionUri: vscode.Uri,
  statusType: number,
  processing: boolean,
): vscode.Uri | vscode.ThemeIcon {
  if (processing || statusType === 2) {
    return new vscode.ThemeIcon('sync~spin');
  }
  if (statusType === 0) {
    return vscode.Uri.joinPath(extensionUri, 'resources', 'status-green.svg');
  }
  return vscode.Uri.joinPath(extensionUri, 'resources', 'status-red.svg');
}

export function getConfiguration<T>(key: string, defaultValue: T): T {
  return vscode.workspace.getConfiguration('vjudge').get<T>(key, defaultValue);
}
