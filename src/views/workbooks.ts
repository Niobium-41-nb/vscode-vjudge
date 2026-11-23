import * as vscode from 'vscode';
import { ProblemRef, WorkbookCategory } from '../api/types';
import { describeError, isLoginError, Session } from '../session';
import {
  createInfoItem,
  createProblemItem,
  createWorkbookCategoryItem,
  createWorkbookItem,
  createWorkbookLoadMoreItem,
  InfoTreeItem,
  ProblemTreeItem,
  WorkbookCategoryTreeItem,
  WorkbookTreeItem,
} from './items';

type WorkbooksNode = WorkbookCategoryTreeItem | WorkbookTreeItem | ProblemTreeItem | InfoTreeItem;

interface CategoryState {
  items: WorkbookTreeItem[];
  total?: number;
  hasMore: boolean;
  loaded: boolean;
  loading?: Promise<void>;
  error?: string;
}

const CATEGORY_ORDER: WorkbookCategory[] = ['joined', 'created', 'followed', 'all'];
const PAGE_SIZE = 50;

const EMPTY_TEXT: Record<WorkbookCategory, string> = {
  joined: '还没有加入任何题单。',
  created: '还没有创建题单。',
  followed: '还没有关注题单。',
  all: '没有找到公开题单。',
};

function isCategoryNode(node: WorkbooksNode): node is WorkbookCategoryTreeItem {
  return typeof (node as WorkbookCategoryTreeItem).category === 'string';
}

function isWorkbookNode(node: WorkbooksNode): node is WorkbookTreeItem {
  return Boolean((node as WorkbookTreeItem).workbook);
}

export class WorkbooksProvider implements vscode.TreeDataProvider<WorkbooksNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WorkbooksNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly states = new Map<WorkbookCategory, CategoryState>();
  private readonly details = new Map<number, ProblemRef[]>();
  private readonly detailErrors = new Map<number, string>();
  private readonly detailLoading = new Set<number>();
  private searchTitle = '';
  private disposed = false;

  constructor(
    private readonly session: Session,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.resetStates();
  }

  private resetStates(): void {
    this.states.clear();
    for (const category of CATEGORY_ORDER) {
      this.states.set(category, {
        items: [],
        hasMore: false,
        loaded: false,
      });
    }
  }

  refresh(): void {
    this.resetStates();
    this.details.clear();
    this.detailErrors.clear();
    this.changeEmitter.fire(undefined);
  }

  async reload(): Promise<void> {
    this.refresh();
  }

  refreshSolveStates(): void {
    const refs = Array.from(this.details.values()).flat();
    if (refs.length === 0) {
      return;
    }
    this.session.applyCachedSolveStates(refs);
    this.changeEmitter.fire(undefined);
  }

  search(title: string): void {
    this.searchTitle = title.trim();
    this.resetStates();
    this.changeEmitter.fire(undefined);
  }

  async loadMore(category: WorkbookCategory): Promise<void> {
    await this.load(category, false);
  }

  private categoryLabel(category: WorkbookCategory): string {
    if (category !== 'all') {
      return { joined: '我加入的', created: '我创建的', followed: '我关注的' }[category];
    }
    return this.searchTitle ? `公开题单：${this.searchTitle}` : '公开题单';
  }

  private async load(category: WorkbookCategory, reset: boolean): Promise<void> {
    const state = this.states.get(category);
    if (!state) {
      return;
    }
    if (state.loading) {
      return state.loading;
    }
    if (!this.session.isLoggedIn) {
      state.items = [];
      state.loaded = false;
      return;
    }
    const start = reset ? 0 : state.items.length;
    const title = category === 'all' ? this.searchTitle : '';
    state.loading = (async () => {
      try {
        const result = await this.session.client.listWorkbooks(category, {
          start,
          length: PAGE_SIZE,
          title,
        });
        if (this.states.get(category) !== state) {
          return;
        }
        const existing = new Set(state.items.map((item) => item.workbook.id));
        const created = result.workbooks
          .filter((workbook) => !existing.has(workbook.id))
          .map(createWorkbookItem);
        state.items = reset ? created : [...state.items, ...created];
        state.total = result.total;
        state.hasMore = result.hasMore && created.length > 0;
        state.error = undefined;
        state.loaded = true;
      } catch (error) {
        if (this.states.get(category) !== state) {
          return;
        }
        state.error = describeError(error);
        state.loaded = true;
        if (isLoginError(error)) {
          void this.session.handleLoginExpired(state.error);
        }
      } finally {
        if (this.states.get(category) === state) {
          state.loading = undefined;
          this.changeEmitter.fire(undefined);
        }
        await this.session.persistCookies();
      }
    })();
    return state.loading;
  }

  private async loadDetail(workbookId: number): Promise<void> {
    if (this.details.has(workbookId) || this.detailLoading.has(workbookId)) {
      return;
    }
    this.detailLoading.add(workbookId);
    try {
      const detail = await this.session.client.getWorkbookDetail(workbookId);
      this.session.applyCachedSolveStates(detail.problems);
      void this.session.prefetchSolveStates();
      this.details.set(workbookId, detail.problems);
      this.detailErrors.delete(workbookId);
    } catch (error) {
      this.detailErrors.set(workbookId, describeError(error));
      if (isLoginError(error)) {
        void this.session.handleLoginExpired(describeError(error));
      }
    } finally {
      this.detailLoading.delete(workbookId);
      await this.session.persistCookies();
      this.changeEmitter.fire(undefined);
    }
  }

  getTreeItem(element: WorkbooksNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorkbooksNode): Promise<WorkbooksNode[]> {
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (!element) {
      return CATEGORY_ORDER.map((category) =>
        createWorkbookCategoryItem(category, this.categoryLabel(category)),
      );
    }
    if (isCategoryNode(element)) {
      return this.getCategoryChildren(element.category);
    }
    if (isWorkbookNode(element)) {
      return this.getWorkbookChildren(element.workbook.id);
    }
    return [];
  }

  private async getCategoryChildren(category: WorkbookCategory): Promise<WorkbooksNode[]> {
    const state = this.states.get(category);
    if (!state) {
      return [];
    }
    if (!state.loaded && !state.loading) {
      await this.load(category, true);
    } else if (state.loading) {
      await state.loading;
    }
    const current = this.states.get(category);
    if (!current) {
      return [];
    }
    if (current.error && current.items.length === 0) {
      return [
        createInfoItem(`加载失败：${current.error}`, {
          icon: 'error',
          command: 'vjudge.refreshWorkbooks',
          tooltip: '点击重试',
        }),
      ];
    }
    if (current.items.length === 0) {
      const text =
        category === 'all' && this.searchTitle
          ? `没有找到标题包含“${this.searchTitle}”的题单。`
          : EMPTY_TEXT[category];
      return [createInfoItem(text, { icon: 'book' })];
    }
    const nodes: WorkbooksNode[] = [...current.items];
    if (current.error) {
      nodes.push(
        createInfoItem(`加载更多失败：${current.error}`, {
          icon: 'error',
          command: 'vjudge.loadMoreWorkbooks',
          commandArgs: [category],
          tooltip: '点击重试',
        }),
      );
    } else if (current.hasMore) {
      const label =
        current.total !== undefined
          ? `加载更多（已显示 ${current.items.length} / ${current.total}）`
          : '加载更多';
      nodes.push(createWorkbookLoadMoreItem(category, label));
    }
    return nodes;
  }

  private async getWorkbookChildren(workbookId: number): Promise<WorkbooksNode[]> {
    const error = this.detailErrors.get(workbookId);
    if (error) {
      return [
        createInfoItem(`加载失败：${error}`, {
          icon: 'error',
          command: 'vjudge.refreshWorkbooks',
          tooltip: '点击重试',
        }),
      ];
    }
    let problems = this.details.get(workbookId);
    if (!problems) {
      await this.loadDetail(workbookId);
      problems = this.details.get(workbookId);
    }
    if (!problems) {
      const detailError = this.detailErrors.get(workbookId);
      return detailError
        ? [
            createInfoItem(`加载失败：${detailError}`, {
              icon: 'error',
              command: 'vjudge.refreshWorkbooks',
              tooltip: '点击重试',
            }),
          ]
        : [];
    }
    if (problems.length === 0) {
      return [createInfoItem('该题单没有题目。', { icon: 'warning' })];
    }
    return problems.map((ref) => createProblemItem(ref, this.extensionUri));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.changeEmitter.dispose();
  }
}
