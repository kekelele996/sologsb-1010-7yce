export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  /** 本机草稿的起点快照；导出校对包时作为三方合并的基线。 */
  mergeAncestor?: ProjectState;
  /** 行冲突后落选的版本，留待组长挑选。 */
  pendingChoices: PendingChoice[];
  /** 因规则集冲突而未合上、等待重试的行。 */
  blockedLines: BlockedLine[];
  /** 已合入过的校对包记录，用于幂等去重。 */
  submissions: SubmissionRecord[];
  lastCheckedAt: string;
  updatedAt: string;
}

/** 校对包：老师离线导出、带回组合入的自包含文件。 */
export interface ProofPackage {
  format: 'braille-atelier-proof-package';
  version: 1;
  packageId: string;
  projectId: string;
  title: string;
  author: string;
  exportedAt: string;
  /** 该老师拿到这份草稿时的原始快照（三方合并基线）。 */
  ancestor: ProjectState;
  /** 老师离线改完后的当前快照。 */
  state: ProjectState;
}

export interface PendingChoiceVersion {
  source: string;
  status: LineStatus;
  note: string;
}

/** 同一行两边都动过时，按规则自动合入后落选的那一版，留待组长挑。 */
export interface PendingChoice {
  id: string;
  packageId: string;
  lineId: string;
  lineNumber: number;
  ours: PendingChoiceVersion;
  theirs: PendingChoiceVersion;
  theirsAuthor: string;
  exportedAt: string;
  createdAt: string;
}

/** 规则集对不上时被拦下、等待重试的行。 */
export interface BlockedLine {
  id: string;
  packageId: string;
  lineId: string;
  lineNumber: number;
  source: string;
  ruleId: string;
  ruleSource: string;
  theirsAuthor: string;
  exportedAt: string;
  createdAt: string;
}

export interface SubmissionRecord {
  packageId: string;
  author: string;
  exportedAt: string;
  mergedAt: string;
  mergedLineCount: number;
  blockedLineCount: number;
  pendingChoiceCount: number;
  status: 'complete' | 'partial';
}

export interface RuleConflictReport {
  ruleSetId: string;
  ruleSetName: string;
  ruleId: string;
  ruleSource: string;
  kind: string;
  ours: { enabled: boolean; output: string; source: string; suspicious: boolean };
  theirs: { enabled: boolean; output: string; source: string; suspicious: boolean };
  affectedLineNumbers: number[];
}

export interface LineConflictReport {
  lineId: string;
  lineNumber: number;
  source: string;
  ours: PendingChoiceVersion;
  theirs: PendingChoiceVersion;
}

export interface MergeReport {
  packageId: string;
  author: string;
  exportedAt: string;
  mergedCount: number;
  addedCount: number;
  lineConflicts: LineConflictReport[];
  blockedLines: BlockedLine[];
  ruleConflicts: RuleConflictReport[];
  status: 'complete' | 'partial';
  reopened: boolean;
  /** 当包的 ancestor 与 state 一致（起始草稿包）时，按“打开为本机草稿”处理。 */
  openedAsDraft: boolean;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
