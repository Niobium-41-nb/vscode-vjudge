import { ProblemRef, Statement } from './api/types';
import { Session } from './session';

const cache = new Map<string, { at: number; statement: Statement }>();
const pending = new Map<string, Promise<Statement>>();
const TTL = 5 * 60 * 1000;

export function statementKey(ref: ProblemRef): string {
  const base = `${ref.oj}-${ref.probNum}`.toLowerCase();
  return ref.contestId !== undefined ? `${base}@${ref.contestId}/${ref.contestNum ?? ''}`.toLowerCase() : base;
}

export function problemUrl(ref: ProblemRef): string {
  if (ref.contestId !== undefined && ref.contestNum) {
    return `https://vjudge.net/contest/${ref.contestId}#problem/${encodeURIComponent(ref.contestNum)}`;
  }
  return `https://vjudge.net/problem/${encodeURIComponent(ref.oj)}-${encodeURIComponent(ref.probNum)}`;
}

export function originProblemUrl(ref: ProblemRef): string {
  return `https://vjudge.net/problem/${encodeURIComponent(ref.oj)}-${encodeURIComponent(ref.probNum)}`;
}

export async function fetchStatement(
  session: Session,
  ref: ProblemRef,
  force = false,
  descriptionId?: number,
): Promise<Statement> {
  const key = `${statementKey(ref)}#${descriptionId ?? ''}`;
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < TTL) {
    return cached.statement;
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  const promise = session.client
    .getStatement(ref, descriptionId)
    .then((statement) => {
      cache.set(key, { at: Date.now(), statement });
      return statement;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}

export function invalidateStatement(ref: ProblemRef): void {
  const prefix = `${statementKey(ref)}#`;
  for (const key of cache.keys()) {
    if (key === statementKey(ref) || key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export function clearStatementCache(): void {
  cache.clear();
}
