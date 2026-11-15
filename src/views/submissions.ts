import * as vscode from 'vscode';
import { describeError, Session } from '../session';
import { getConfiguration } from '../utils';
import { createInfoItem, createSubmissionItem, InfoTreeItem, SubmissionTreeItem } from './items';

type SubmissionsNode = SubmissionTreeItem | InfoTreeItem;

export class SubmissionsProvider implements vscode.TreeDataProvider<SubmissionsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<SubmissionsNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private items: SubmissionTreeItem[] = [];
  private loaded = false;
  private loading?: Promise<void>;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly session: Session,
    private readonly extensionUri: vscode.Uri,
  ) {}

  refresh(): void {
    this.loaded = false;
    this.error = undefined;
    this.changeEmitter.fire(undefined);
  }

  async reload(silent = false): Promise<void> {
    if (this.loading) {
      return this.loading;
    }
    if (!this.session.isLoggedIn) {
      this.items = [];
      this.loaded = false;
      if (!silent) {
        this.changeEmitter.fire(undefined);
      }
      return;
    }
    const username = this.session.username;
    if (!username) {
      this.items = [];
      this.loaded = true;
      if (!silent) {
        this.changeEmitter.fire(undefined);
      }
      return;
    }
    this.loading = (async () => {
      try {
        const pageSize = Math.max(5, getConfiguration('submissionPageSize', 30));
        const submissions = await this.session.client.listSubmissions(username, pageSize);
        this.items = submissions.map((submission) =>
          createSubmissionItem(submission, this.extensionUri),
        );
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

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const seconds = getConfiguration('statusRefreshInterval', 30);
    if (seconds <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.session.isLoggedIn) {
        void this.reload(true);
      }
    }, Math.max(5, seconds) * 1000);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stopAutoRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getTreeItem(element: SubmissionsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SubmissionsNode): Promise<SubmissionsNode[]> {
    if (element) {
      return [];
    }
    if (!this.session.isLoggedIn) {
      return [];
    }
    if (!this.session.username) {
      return [
        createInfoItem('尚未设置用户名，无法获取提交记录。', {
          icon: 'account',
          command: 'vjudge.setUsername',
          tooltip: '点击设置用户名',
        }),
      ];
    }
    if (!this.loaded && !this.loading) {
      await this.reload(false);
    } else if (this.loading) {
      await this.loading;
    }
    if (this.error && this.items.length === 0) {
      return [
        createInfoItem(`加载失败：${this.error}`, {
          icon: 'error',
          command: 'vjudge.refreshSubmissions',
          tooltip: '点击重试',
        }),
      ];
    }
    if (this.items.length === 0) {
      return [createInfoItem('暂无提交记录。', { icon: 'history' })];
    }
    return this.items;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopAutoRefresh();
    this.changeEmitter.dispose();
  }
}
