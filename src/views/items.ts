import * as vscode from 'vscode';
import {
  ContestSummary,
  ProblemRef,
  SubmissionSummary,
  WorkbookCategory,
  WorkbookSummary,
} from '../api/types';
import { statementKey } from '../statementCache';
import {
  contestTypeLabel,
  formatDateTime,
  formatMemory,
  formatRelativeTime,
  formatRuntime,
  statusIcon,
  truncate,
  workbookOpennessLabel,
} from '../utils';

export interface ProblemTreeItem extends vscode.TreeItem {
  ref: ProblemRef;
}

export interface InfoTreeItem extends vscode.TreeItem {
  info: true;
}

export function createInfoItem(
  label: string,
  options: {
    icon?: string;
    command?: string;
    tooltip?: string;
    commandArgs?: unknown[];
  } = {},
): InfoTreeItem {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as InfoTreeItem;
  item.info = true;
  item.contextValue = 'vjudge.info';
  item.iconPath = new vscode.ThemeIcon(options.icon ?? 'info');
  if (options.tooltip) {
    item.tooltip = options.tooltip;
  }
  if (options.command) {
    item.command = {
      command: options.command,
      title: label,
      arguments: options.commandArgs,
    };
  }
  return item;
}

export function createLoadMoreItem(label = '加载更多…'): InfoTreeItem {
  return createInfoItem(label, { icon: 'ellipsis', command: 'vjudge.loadMoreProblems' });
}

export interface ContestTreeItem extends vscode.TreeItem {
  contest: ContestSummary;
}

export interface SubmissionTreeItem extends vscode.TreeItem {
  submission: SubmissionSummary;
}

export function createProblemItem(ref: ProblemRef, extensionUri: vscode.Uri): ProblemTreeItem {
  const title = ref.title?.trim() || '(未命名题目)';
  const label = ref.contestNum
    ? `#${ref.contestNum}  ${title}`
    : `${ref.oj}-${ref.probNum}  ${title}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as ProblemTreeItem;
  item.ref = ref;
  item.id = statementKey(ref);
  item.contextValue = 'vjudge.problem';
  const baseDescription = ref.contestNum
    ? `${ref.oj}-${ref.probNum}`
    : truncate(ref.source || '', 48);
  const stateLabel =
    ref.solvedState === 1 ? '已通过' : ref.solvedState === 0 ? '尝试过' : ref.solvedState === -1 ? '未做' : '';
  item.description = [stateLabel, baseDescription].filter(Boolean).join(' · ');

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${ref.oj}-${ref.probNum}**\n\n`);
  tooltip.appendText(title);
  if (ref.source) {
    tooltip.appendMarkdown(`\n\n来源：`).appendText(truncate(ref.source, 200));
  }
  if (ref.solvedState === 1) {
    tooltip.appendMarkdown('\n\n状态：已通过');
  } else if (ref.solvedState === 0) {
    tooltip.appendMarkdown('\n\n状态：尝试过（尚未通过）');
  } else if (ref.solvedState === -1) {
    tooltip.appendMarkdown('\n\n状态：未做（当前账号没有提交记录）');
  }
  item.tooltip = tooltip;

  if (ref.solvedState === 1) {
    item.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'status-green.svg');
  } else if (ref.solvedState === 0) {
    item.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'status-red.svg');
  } else if (ref.solvedState === -1) {
    item.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'status-grey.svg');
  } else {
    item.iconPath = new vscode.ThemeIcon('file-text');
  }

  item.command = {
    command: 'vjudge.openProblem',
    title: '打开题面',
    arguments: [ref],
  };
  return item;
}

export function createContestItem(contest: ContestSummary): ContestTreeItem {
  const item = new vscode.TreeItem(
    contest.title || `比赛 ${contest.id}`,
    vscode.TreeItemCollapsibleState.Collapsed,
  ) as ContestTreeItem;
  item.contest = contest;
  item.id = `vjudge-contest-${contest.id}`;
  item.contextValue = 'vjudge.contest';
  item.iconPath = new vscode.ThemeIcon('calendar');
  item.description = `#${contest.id} · ${contestTypeLabel(contest.type)}`;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${contest.title}**\n\n`);
  tooltip.appendMarkdown(`比赛 ID：${contest.id}\n\n`);
  tooltip.appendMarkdown(`类型：${contestTypeLabel(contest.type)}\n\n`);
  tooltip.appendMarkdown(`开始：${formatDateTime(contest.begin)}\n\n`);
  tooltip.appendMarkdown(`结束：${formatDateTime(contest.end)}\n\n`);
  tooltip.appendMarkdown(`管理员：${contest.managerName || '未知'}`);
  item.tooltip = tooltip;
  return item;
}

export interface WorkbookCategoryTreeItem extends vscode.TreeItem {
  category: WorkbookCategory;
}

export interface WorkbookTreeItem extends vscode.TreeItem {
  workbook: WorkbookSummary;
}

const WORKBOOK_CATEGORY_ICONS: Record<WorkbookCategory, string> = {
  joined: 'check',
  created: 'edit',
  followed: 'star',
  all: 'book',
};

export function createWorkbookCategoryItem(
  category: WorkbookCategory,
  label: string,
  description?: string,
): WorkbookCategoryTreeItem {
  const item = new vscode.TreeItem(
    label,
    vscode.TreeItemCollapsibleState.Collapsed,
  ) as WorkbookCategoryTreeItem;
  item.category = category;
  item.id = `vjudge-workbook-category-${category}`;
  item.contextValue = 'vjudge.workbookCategory';
  item.iconPath = new vscode.ThemeIcon(WORKBOOK_CATEGORY_ICONS[category]);
  if (description) {
    item.description = description;
  }
  return item;
}

export function createWorkbookItem(workbook: WorkbookSummary): WorkbookTreeItem {
  const item = new vscode.TreeItem(
    workbook.title || `题单 ${workbook.id}`,
    vscode.TreeItemCollapsibleState.Collapsed,
  ) as WorkbookTreeItem;
  item.workbook = workbook;
  item.id = `vjudge-workbook-${workbook.id}`;
  item.contextValue = 'vjudge.workbook';
  item.iconPath = new vscode.ThemeIcon(workbook.openness === 2 ? 'book' : 'lock');
  item.description = [
    workbook.author || '未知作者',
    `${workbook.problemCount} 题`,
    workbook.openness === 2 ? '' : workbookOpennessLabel(workbook.openness),
  ]
    .filter(Boolean)
    .join(' · ');

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${workbook.title || '未命名题单'}**\n\n`);
  tooltip.appendMarkdown(`题单 ID：${workbook.id}\n\n`);
  tooltip.appendMarkdown(`作者：${workbook.author || '未知'}\n\n`);
  tooltip.appendMarkdown(`可见性：${workbookOpennessLabel(workbook.openness)}\n\n`);
  tooltip.appendMarkdown(`题目数：${workbook.problemCount}\n\n`);
  tooltip.appendMarkdown(
    `加入人数：${workbook.joinedUsers}　活跃：${workbook.activeUsers}　浏览：${workbook.viewCnt}\n\n`,
  );
  tooltip.appendMarkdown(`更新时间：${formatDateTime(workbook.updateTime)}`);
  item.tooltip = tooltip;
  return item;
}

export function createWorkbookLoadMoreItem(
  category: WorkbookCategory,
  label: string,
): InfoTreeItem {
  return createInfoItem(label, {
    icon: 'ellipsis',
    command: 'vjudge.loadMoreWorkbooks',
    commandArgs: [category],
  });
}

export function createSubmissionItem(
  submission: SubmissionSummary,
  extensionUri: vscode.Uri,
): SubmissionTreeItem {
  const item = new vscode.TreeItem(
    `#${submission.runId}  ${submission.oj}-${submission.probNum}`,
    vscode.TreeItemCollapsibleState.None,
  ) as SubmissionTreeItem;
  item.submission = submission;
  item.contextValue = 'vjudge.submission';
  item.description = submission.processing ? '评测中…' : submission.status;
  item.iconPath = statusIcon(extensionUri, submission.statusType, submission.processing);

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${submission.status || '未知状态'}**\n\n`);
  tooltip.appendMarkdown(`题目：${submission.oj}-${submission.probNum}\n\n`);
  tooltip.appendMarkdown(`语言：${submission.language || '未知'}\n\n`);
  tooltip.appendMarkdown(`时间：${formatRuntime(submission.runtime)}　内存：${formatMemory(submission.memory)}\n\n`);
  tooltip.appendMarkdown(`提交于：${formatDateTime(submission.time)}（${formatRelativeTime(submission.time)}）`);
  item.tooltip = tooltip;

  item.command = {
    command: 'vjudge.showSubmission',
    title: '查看提交详情',
    arguments: [submission],
  };
  return item;
}
