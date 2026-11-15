import * as vscode from 'vscode';
import { ProblemRef } from './api/types';
import { statementKey } from './statementCache';

const files = new Map<string, { ref: ProblemRef; uri: vscode.Uri }>();

export function rememberProblemFile(ref: ProblemRef, uri: vscode.Uri): void {
  files.set(statementKey(ref), { ref, uri });
}

export function forgetProblemFile(uri: vscode.Uri): void {
  const target = uri.toString();
  for (const [key, entry] of files) {
    if (entry.uri.toString() === target) {
      files.delete(key);
    }
  }
}

export function problemFile(ref: ProblemRef): vscode.Uri | undefined {
  return files.get(statementKey(ref))?.uri;
}

export function problemForFile(uri: vscode.Uri): ProblemRef | undefined {
  const target = uri.toString();
  for (const entry of files.values()) {
    if (entry.uri.toString() === target) {
      return entry.ref;
    }
  }
  return undefined;
}
