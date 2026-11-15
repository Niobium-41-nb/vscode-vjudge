import * as vscode from 'vscode';
import { SearchProblemOptions } from '../api/types';
import { describeError, Session } from '../session';
import { getConfiguration } from '../utils';
import {
  createInfoItem,
  createLoadMoreItem,
  createProblemItem,
  InfoTreeItem,
  ProblemTreeItem,
} from './items';

type ProblemsNode = ProblemTreeItem | InfoTreeItem;

export class ProblemsProvider implements vscode.TreeDataProvider<ProblemsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ProblemsNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private criteria: SearchProblemOptions = {};
  private items: ProblemTreeItem[] = [];
  private total = 0;
  private loaded = false;
  private loading?: Promise<void>;
  private error?: string;
  private disposed = false;

  constructor(
    private readonly session: Session,
    private readonly extensionUri: vscode.Uri,
  ) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  async search(criteria: SearchProblemOptions): Promise<void> {
    this.criteria = { ...criteria };
    this.items = [];
    this.total = 0;
    this.loaded = false;
    this.error = undefined;
    this.changeEmitter.fire(undefined);
  }

  async loadMore(): Promise<void> {
    await this.load(false);
  }

  async reload(): Promise<void> {
    this.items = [];
    this.total = 0;
    this.loaded = false;
    this.error = undefined;
    await this.load(true);
  }

  refreshSolveStates(): void {
    if (this.items.length === 0) {
      return;
    }
    this.session.applyCachedSolveStates(this.items.map((item) => item.ref));
    this.items = this.items.map((item) => createProblemItem(item.ref, this.extensionUri));
    this.changeEmitter.fire(undefined);
  }

  get currentCriteria(): SearchProblemOptions {
    return this.criteria;
  }

  private async load(reset: boolean): Promise<void> {
    if (this.loading) {
      return this.loading;
    }
    if (!this.session.isLoggedIn) {
      this.items = [];
      this.loaded = false;
      return;
    }
    const pageSize = Math.max(10, getConfiguration('problemPageSize', 50));
    const start = reset ? 0 : this.items.length;
    this.loading = (async () => {
      try {
        const result = await this.session.client.searchProblems({
          ...this.criteria,
          start,
          length: pageSize,
        });
        const refs = result.problems.map((problem) => ({
          oj: problem.oj,
          probNum: problem.probNum,
          title: problem.title,
          source: problem.source,
          problemId: problem.id,
        }));
        this.session.applyCachedSolveStates(refs);
        void this.session.prefetchSolveStates();
        const created = refs.map((ref) => createProblemItem(ref, this.extensionUri));
        this.items = reset ? created : [...this.items, ...created];
        this.total = result.total;
        this.error = undefined;
        this.loaded = true;
      } catch (error) {
        this.error = describeError(error);
        this.loaded = true;
      } finally {
        this.loading = undefined;
        await this.session.persistCookies();
        this.changeEmitter.fire(undefined);
      }
    })();
    return this.loading;
  }

  getTreeItem(element: ProblemsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProblemsNode): Promise<ProblemsNode[]> {
    if (element) {
      return [];
    }
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (!this.loaded && !this.loading) {
      await this.load(true);
    } else if (this.loading) {
      await this.loading;
    }
    if (this.error && this.items.length === 0) {
      return [
        createInfoItem(`加载失败：${this.error}`, {
          icon: 'error',
          command: 'vjudge.refreshProblems',
          tooltip: '点击重试',
        }),
      ];
    }
    if (this.items.length === 0) {
      return [
        createInfoItem('没有找到题目，点击重新搜索。', {
          icon: 'search',
          command: 'vjudge.searchProblem',
        }),
      ];
    }
    const nodes: ProblemsNode[] = [...this.items];
    if (this.error) {
      nodes.push(
        createInfoItem(`加载更多失败：${this.error}`, {
          icon: 'error',
          command: 'vjudge.loadMoreProblems',
          tooltip: '点击重试',
        }),
      );
    } else if (this.items.length < this.total) {
      nodes.push(createLoadMoreItem(`加载更多（已显示 ${this.items.length} / ${this.total}）`));
    }
    return nodes;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}
