import * as vscode from 'vscode';
import { ContestDetail, ProblemRef } from '../api/types';
import { describeError, Session } from '../session';
import {
  ContestTreeItem,
  createContestItem,
  createInfoItem,
  createProblemItem,
  InfoTreeItem,
  ProblemTreeItem,
} from './items';

type ContestsNode = ContestTreeItem | ProblemTreeItem | InfoTreeItem;

export class ContestsProvider implements vscode.TreeDataProvider<ContestsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ContestsNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private contests: ContestTreeItem[] = [];
  private loaded = false;
  private loading?: Promise<void>;
  private error?: string;
  private readonly details = new Map<number, ProblemRef[]>();
  private readonly detailErrors = new Map<number, string>();
  private readonly detailLoading = new Set<number>();
  private disposed = false;

  constructor(
    private readonly session: Session,
    private readonly extensionUri: vscode.Uri,
  ) {}

  refresh(): void {
    this.loaded = false;
    this.error = undefined;
    this.details.clear();
    this.detailErrors.clear();
    this.changeEmitter.fire(undefined);
  }

  async reload(): Promise<void> {
    this.contests = [];
    this.refresh();
    await this.load();
  }

  refreshSolveStates(): void {
    const refs = Array.from(this.details.values()).flat();
    if (refs.length === 0) {
      return;
    }
    this.session.applyCachedSolveStates(refs);
    this.changeEmitter.fire(undefined);
  }

  private async load(): Promise<void> {
    if (this.loading) {
      return this.loading;
    }
    if (!this.session.isLoggedIn) {
      this.contests = [];
      this.loaded = false;
      return;
    }
    this.loading = (async () => {
      try {
        const contests = await this.session.client.listContests('mine', 100);
        this.contests = contests.map(createContestItem);
        this.error = undefined;
      } catch (error) {
        this.error = describeError(error);
        this.contests = [];
      } finally {
        this.loaded = true;
        this.loading = undefined;
        await this.session.persistCookies();
        this.changeEmitter.fire(undefined);
      }
    })();
    return this.loading;
  }

  private async loadDetail(contestId: number): Promise<void> {
    if (this.details.has(contestId) || this.detailLoading.has(contestId)) {
      return;
    }
    this.detailLoading.add(contestId);
    try {
      const detail: ContestDetail = await this.session.client.getContestDetail(contestId);
      const refs: ProblemRef[] = detail.problems.map((problem) => ({
        oj: problem.oj,
        probNum: problem.probNum,
        title: problem.title,
        contestId,
        contestNum: problem.num,
        languages: problem.languages,
        descBriefs: problem.descBriefs,
        enabledDescKeys: problem.enabledDescKeys,
        properties: problem.properties,
        problemId: problem.pid,
      }));
      this.session.applyCachedSolveStates(refs);
      void this.session.prefetchSolveStates();
      this.details.set(contestId, refs);
      this.detailErrors.delete(contestId);
    } catch (error) {
      this.detailErrors.set(contestId, describeError(error));
    } finally {
      this.detailLoading.delete(contestId);
      await this.session.persistCookies();
      this.changeEmitter.fire(undefined);
    }
  }

  getTreeItem(element: ContestsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ContestsNode): Promise<ContestsNode[]> {
    if (!this.session.isLoggedIn) {
      return [];
    }

    if (element) {
      const contest = (element as ContestTreeItem).contest;
      if (!contest) {
        return [];
      }
      const detailError = this.detailErrors.get(contest.id);
      if (detailError) {
        return [
          createInfoItem(`加载失败：${detailError}`, {
            icon: 'error',
            command: 'vjudge.refreshContests',
            tooltip: '点击重试',
          }),
        ];
      }
      const problems = this.details.get(contest.id);
      if (!problems) {
        await this.loadDetail(contest.id);
        const loaded = this.details.get(contest.id);
        if (loaded) {
          return loaded.map((ref) => createProblemItem(ref, this.extensionUri));
        }
        return [];
      }
      if (problems.length === 0) {
        return [createInfoItem('该比赛没有可用的题目。', { icon: 'warning' })];
      }
      return problems.map((ref) => createProblemItem(ref, this.extensionUri));
    }

    if (!this.loaded && !this.loading) {
      await this.load();
    } else if (this.loading) {
      await this.loading;
    }
    if (this.error) {
      return [
        createInfoItem(`加载失败：${this.error}`, {
          icon: 'error',
          command: 'vjudge.refreshContests',
          tooltip: '点击重试',
        }),
      ];
    }
    if (this.contests.length === 0) {
      return [createInfoItem('没有找到你参加过的比赛。', { icon: 'calendar' })];
    }
    return this.contests;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}
