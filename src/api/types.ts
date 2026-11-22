export type SolveState = -1 | 0 | 1;

export interface ProblemRef {
  oj: string;
  probNum: string;
  title?: string;
  source?: string;
  problemId?: number;
  contestId?: number;
  contestNum?: string;
  languages?: Record<string, string>;
  descBriefs?: DescriptionBrief[];
  enabledDescKeys?: number[];
  properties?: ProblemProperty[];
  solvedState?: SolveState;
}

export interface DescriptionBrief {
  key: number;
  version: number;
  author?: string;
  lang?: string;
  langDisplay?: string;
  type?: string;
  updateDate?: string;
  official?: boolean;
}

export interface ProblemProperty {
  title: string;
  content: string;
  spoiler?: boolean;
}

export interface ProblemSummary {
  id: number;
  oj: string;
  probNum: string;
  title: string;
  source: string;
  available: boolean;
  solvedUsers: number;
}

export interface SolveRecords {
  accepted: Set<string>;
  attempted: Set<string>;
}

export interface ContestSummary {
  id: number;
  title: string;
  type: number;
  begin: number;
  end: number;
  openness: number;
  contestants: number;
  managerName: string;
  groupName?: string;
  isFav: number;
}

export interface ContestProblem {
  pid: number;
  oj: string;
  probNum: string;
  num: string;
  title: string;
  languages: Record<string, string>;
  enabledDescKeys?: number[];
  descBriefs?: DescriptionBrief[];
  properties?: ProblemProperty[];
  weight?: number;
}

export interface ContestDetail {
  id: number;
  title: string;
  type?: number;
  openness?: number;
  authStatus?: number;
  begin?: number;
  end?: number;
  managerName?: string;
  problems: ContestProblem[];
}

export type WorkbookCategory = 'joined' | 'created' | 'followed' | 'all';

export interface WorkbookSummary {
  id: number;
  title: string;
  problemCount: number;
  joinedUsers: number;
  activeUsers: number;
  viewCnt: number;
  author: string;
  openness: number;
  updateTime: number;
}

export interface WorkbookListResult {
  workbooks: WorkbookSummary[];
  total?: number;
  hasMore: boolean;
}

export interface WorkbookDetail {
  id: number;
  title: string;
  author: string;
  openness: number;
  joined: boolean;
  viewCnt: number;
  createTime: number;
  updateTime: number;
  content: string;
  nodeId: number;
  problems: ProblemRef[];
}

export interface WorkbookInput {
  title: string;
  content: string;
  openness: number;
  nodeId?: number;
}

export interface DescriptionRef {
  id: number;
  version: number;
  author?: string;
  official?: boolean;
  lang?: string;
  langDisplay?: string;
  type?: string;
  updateDate?: string;
  remarks?: string;
}

export interface ProblemDetail {
  oj: string;
  probNum: string;
  title: string;
  problemId?: number;
  languages: Record<string, string>;
  descriptions: DescriptionRef[];
  accepted?: boolean;
  attempted?: boolean;
  allowSubmit?: boolean;
  status?: number;
  properties?: ProblemProperty[];
}

export interface Sample {
  input: string;
  output: string;
}

export interface Statement {
  oj: string;
  probNum: string;
  title: string;
  html: string;
  samples: Sample[];
  languages: Record<string, string>;
  descriptions?: DescriptionRef[];
  descriptionId?: number;
}

export interface Solution {
  runId: number;
  status: string;
  statusType: number;
  processing: boolean;
  runtime?: number;
  memory?: number;
  language?: string;
  languageCanonical?: string;
  oj?: string;
  probNum?: string;
  contestId?: number;
  contestNum?: string;
  submitTime?: number;
  author?: string;
  authorId?: number;
  sourceLength?: number;
  isOpen?: number;
  code?: string;
  additionalInfo?: string;
  [key: string]: unknown;
}

export interface SubmissionSummary {
  runId: number;
  status: string;
  statusType: number;
  processing: boolean;
  runtime: number;
  memory: number;
  language: string;
  oj: string;
  probNum: string;
  time: number;
  userName?: string;
  problemId?: number;
  contestId?: number;
  sourceLength?: number;
}

export interface SearchProblemOptions {
  oj?: string;
  probNum?: string;
  title?: string;
  source?: string;
  category?: string;
  start?: number;
  length?: number;
}

export interface SubmitOptions {
  oj: string;
  probNum: string;
  title?: string;
  contestId?: number;
  contestNum?: string;
  language: string;
  code: string;
  captcha?: string;
  open?: boolean;
  method?: number;
  bindingId?: number;
}

export interface RemoteAccountBinding {
  id: number;
  accountId?: string;
  accountDisplay?: string;
  runtimeStatus?: string;
}
