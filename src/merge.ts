import { analyzeProject } from './braille';
import type {
  BlockedLine,
  LineConflictReport,
  MergeReport,
  PendingChoice,
  PendingChoiceVersion,
  ProofPackage,
  ProjectState,
  RuleConflictReport,
  RuleSet,
  SubmissionRecord,
  TextbookLine,
  TranscriptionRule,
} from './types';

export const PACKAGE_FORMAT = 'braille-atelier-proof-package';
export const PACKAGE_VERSION = 1;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 去掉快照里嵌套的 mergeAncestor，避免层层膨胀。 */
function stripAncestor(state: ProjectState): ProjectState {
  const { mergeAncestor: _ancestor, ...rest } = state;
  return rest as ProjectState;
}

/** 作为“同步点”的干净快照：只保留课文与规则，去掉合并记录与问题。 */
function cleanStartingState(state: ProjectState): ProjectState {
  const {
    mergeAncestor: _ma,
    pendingChoices: _pc,
    blockedLines: _bl,
    submissions: _sub,
    issues: _issues,
    ...rest
  } = structuredClone(state) as ProjectState;
  return rest as ProjectState;
}

export function isProofPackage(value: unknown): value is ProofPackage {
  return Boolean(value)
    && typeof value === 'object'
    && (value as ProofPackage).format === PACKAGE_FORMAT
    && (value as ProofPackage).version === PACKAGE_VERSION
    && Array.isArray((value as ProofPackage).state?.lines);
}

export function createProofPackage(state: ProjectState, author: string): ProofPackage {
  const ancestorSource = state.mergeAncestor ?? state;
  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    packageId: uid('pkg'),
    projectId: state.id,
    title: state.title,
    author: author.trim() || '未署名老师',
    exportedAt: new Date().toISOString(),
    ancestor: stripAncestor(structuredClone(ancestorSource)),
    state: stripAncestor(structuredClone(state)),
  };
}

function ruleSignature(rule: TranscriptionRule): string {
  return [rule.source, rule.output, rule.kind, rule.enabled, rule.suspicious].join('|');
}

function ruleSetSignature(set: RuleSet): string {
  return [set.name, set.description, set.contractions, set.hyphenMode].join('|');
}

function lineSignature(line: TextbookLine): string {
  return [line.source, line.status, line.note].join('|');
}

/** 起始草稿包：ancestor 与 state 内容一致，老师拿到后应直接作为本机草稿起点。 */
export function isBasePackage(pkg: ProofPackage): boolean {
  const a = pkg.ancestor;
  const b = pkg.state;
  if (!a || !b) return false;
  if (a.lines.length !== b.lines.length || a.ruleSets.length !== b.ruleSets.length) return false;
  for (let i = 0; i < a.lines.length; i += 1) {
    const la = a.lines[i];
    const lb = b.lines[i];
    if (la.id !== lb.id || la.source !== lb.source || la.status !== lb.status || la.note !== lb.note) return false;
  }
  for (let i = 0; i < a.ruleSets.length; i += 1) {
    const ra = a.ruleSets[i];
    const rb = b.ruleSets[i];
    if (ra.id !== rb.id || ra.rules.length !== rb.rules.length) return false;
    for (let j = 0; j < ra.rules.length; j += 1) {
      if (ra.rules[j].id !== rb.rules[j].id || ruleSignature(ra.rules[j]) !== ruleSignature(rb.rules[j])) return false;
    }
  }
  return true;
}

/** 把起始草稿包作为本机草稿打开，并记录基线供下次导出使用。 */
export function openPackageAsDraft(pkg: ProofPackage): ProjectState {
  const base = stripAncestor(structuredClone(pkg.state));
  return {
    ...base,
    selectedLineId: base.lines[0]?.id ?? '',
    issues: [],
    pendingChoices: [],
    blockedLines: [],
    submissions: [],
    mergeAncestor: cleanStartingState(pkg.state),
    updatedAt: new Date().toISOString(),
  };
}

function versionOf(line: TextbookLine): PendingChoiceVersion {
  return { source: line.source, status: line.status, note: line.note };
}

/** 统计某条规则在对方稿件中影响到的行号（1 基）。 */
function affectedLineNumbers(ruleId: string, theirs: ProjectState): number[] {
  const numbers: number[] = [];
  theirs.lines.forEach((line, index) => {
    if (line.tokens.some((token) => token.ruleId === ruleId)) numbers.push(index + 1);
  });
  return numbers;
}

interface RuleMergeOut {
  set: RuleSet | undefined;
  conflicts: RuleConflictReport[];
  conflictingRuleIds: Set<string>;
  setLevelConflict: boolean;
}

function mergeRuleSet(
  baseSet: RuleSet | undefined,
  ourSet: RuleSet | undefined,
  theirSet: RuleSet | undefined,
  theirs: ProjectState,
): RuleMergeOut {
  const conflicts: RuleConflictReport[] = [];
  const conflictingRuleIds = new Set<string>();
  let setLevelConflict = false;

  if (!ourSet && !theirSet) return { set: undefined, conflicts, conflictingRuleIds, setLevelConflict };
  const fallback = theirSet ?? ourSet!;
  const merged: RuleSet = { ...fallback, rules: [] };

  // 规则集整体字段（缩写开关 / 断行模式）
  const ourSetChanged = Boolean(baseSet && ourSet && ruleSetSignature(ourSet) !== ruleSetSignature(baseSet));
  const theirSetChanged = Boolean(baseSet && theirSet && ruleSetSignature(theirSet) !== ruleSetSignature(baseSet));
  if (ourSetChanged && theirSetChanged && ourSet && theirSet && ruleSetSignature(ourSet) !== ruleSetSignature(theirSet)) {
    setLevelConflict = true;
    conflicts.push({
      ruleSetId: fallback.id,
      ruleSetName: fallback.name,
      ruleId: '__set__',
      ruleSource: '规则集整体设置（缩写开关 / 断行模式）',
      kind: 'special',
      ours: { enabled: true, output: ruleSetSignature(ourSet), source: '', suspicious: false },
      theirs: { enabled: true, output: ruleSetSignature(theirSet), source: '', suspicious: false },
      affectedLineNumbers: theirs.lines.map((_, index) => index + 1),
    });
  } else if (theirSetChanged && !ourSetChanged && theirSet) {
    merged.name = theirSet.name;
    merged.description = theirSet.description;
    merged.contractions = theirSet.contractions;
    merged.hyphenMode = theirSet.hyphenMode;
  } else if (ourSet) {
    merged.name = ourSet.name;
    merged.description = ourSet.description;
    merged.contractions = ourSet.contractions;
    merged.hyphenMode = ourSet.hyphenMode;
  }

  // 规则逐条三方合并
  const ruleIds = new Set<string>([
    ...(baseSet?.rules.map((rule) => rule.id) ?? []),
    ...(ourSet?.rules.map((rule) => rule.id) ?? []),
    ...(theirSet?.rules.map((rule) => rule.id) ?? []),
  ]);

  ruleIds.forEach((ruleId) => {
    const baseRule = baseSet?.rules.find((rule) => rule.id === ruleId);
    const ourRule = ourSet?.rules.find((rule) => rule.id === ruleId);
    const theirRule = theirSet?.rules.find((rule) => rule.id === ruleId);

    let mergedRule: TranscriptionRule | undefined;
    let conflict = false;

    if (ourRule && theirRule) {
      const ourChanged = !baseRule || ruleSignature(ourRule) !== ruleSignature(baseRule);
      const theirChanged = !baseRule || ruleSignature(theirRule) !== ruleSignature(baseRule);
      if (ourChanged && theirChanged) {
        if (ruleSignature(ourRule) === ruleSignature(theirRule)) {
          mergedRule = ourRule; // 两边改到一致
        } else {
          conflict = true;
          mergedRule = ourRule;
        }
      } else if (ourChanged) {
        mergedRule = ourRule;
      } else if (theirChanged) {
        mergedRule = theirRule;
      } else {
        mergedRule = ourRule;
      }
    } else if (ourRule && !theirRule) {
      // 对方删了，我方改了 → 冲突；我方没改 → 接受删除
      const ourChanged = !baseRule || ruleSignature(ourRule) !== ruleSignature(baseRule);
      if (ourChanged) {
        conflict = true;
        mergedRule = ourRule;
      }
    } else if (!ourRule && theirRule) {
      // 我方删了，对方改了 → 冲突；对方没改 → 接受删除
      const theirChanged = !baseRule || ruleSignature(theirRule) !== ruleSignature(baseRule);
      if (theirChanged) {
        conflict = true;
        mergedRule = theirRule;
      }
    } else if (theirRule) {
      mergedRule = theirRule;
    } else if (ourRule) {
      mergedRule = ourRule;
    }

    if (conflict) {
      conflictingRuleIds.add(ruleId);
      conflicts.push({
        ruleSetId: fallback.id,
        ruleSetName: fallback.name,
        ruleId,
        ruleSource: (theirRule ?? ourRule)?.source || ruleId,
        kind: (theirRule ?? ourRule)?.kind ?? 'special',
        ours: {
          enabled: ourRule?.enabled ?? false,
          output: ourRule?.output ?? '',
          source: ourRule?.source ?? '',
          suspicious: ourRule?.suspicious ?? false,
        },
        theirs: {
          enabled: theirRule?.enabled ?? false,
          output: theirRule?.output ?? '',
          source: theirRule?.source ?? '',
          suspicious: theirRule?.suspicious ?? false,
        },
        affectedLineNumbers: affectedLineNumbers(ruleId, theirs),
      });
    }

    if (mergedRule) merged.rules.push(mergedRule);
  });

  return { set: merged, conflicts, conflictingRuleIds, setLevelConflict };
}

export interface MergeOutcome {
  state: ProjectState;
  report: MergeReport;
}

/** 把校对包三方合入当前草稿。 */
export function mergeProofPackage(current: ProjectState, pkg: ProofPackage): MergeOutcome {
  if (isBasePackage(pkg)) {
    return {
      state: openPackageAsDraft(pkg),
      report: {
        packageId: pkg.packageId,
        author: pkg.author,
        exportedAt: pkg.exportedAt,
        mergedCount: 0,
        addedCount: 0,
        lineConflicts: [],
        blockedLines: [],
        ruleConflicts: [],
        status: 'complete',
        reopened: false,
        openedAsDraft: true,
      },
    };
  }

  const base = pkg.ancestor;
  const ours = current;
  const theirs = pkg.state;

  const report: MergeReport = {
    packageId: pkg.packageId,
    author: pkg.author,
    exportedAt: pkg.exportedAt,
    mergedCount: 0,
    addedCount: 0,
    lineConflicts: [],
    blockedLines: [],
    ruleConflicts: [],
    status: 'complete',
    reopened: Boolean(ours.submissions.some((record) => record.packageId === pkg.packageId)),
    openedAsDraft: false,
  };

  // 1. 规则集三方合并，收集冲突
  const allSetIds = new Set<string>([
    ...base.ruleSets.map((set) => set.id),
    ...ours.ruleSets.map((set) => set.id),
    ...theirs.ruleSets.map((set) => set.id),
  ]);

  const mergedRuleSets: RuleSet[] = [];
  const conflictingRuleIds = new Set<string>();
  let anySetLevelConflict = false;

  allSetIds.forEach((setId) => {
    const baseSet = base.ruleSets.find((set) => set.id === setId);
    const ourSet = ours.ruleSets.find((set) => set.id === setId);
    const theirSet = theirs.ruleSets.find((set) => set.id === setId);
    const out = mergeRuleSet(baseSet, ourSet, theirSet, theirs);
    if (out.set) mergedRuleSets.push(out.set);
    out.conflicts.forEach((conflict) => report.ruleConflicts.push(conflict));
    out.conflictingRuleIds.forEach((ruleId) => conflictingRuleIds.add(ruleId));
    if (out.setLevelConflict) anySetLevelConflict = true;
  });

  const ruleSets = mergedRuleSets.length > 0 ? mergedRuleSets : structuredClone(ours.ruleSets);

  // 活动规则集
  const baseActive = base.activeRuleSetId;
  const ourActiveChanged = ours.activeRuleSetId !== baseActive;
  const theirActiveChanged = theirs.activeRuleSetId !== baseActive;
  let activeRuleSetId = ours.activeRuleSetId;
  if (ourActiveChanged && theirActiveChanged && ours.activeRuleSetId !== theirs.activeRuleSetId) {
    anySetLevelConflict = true;
    report.ruleConflicts.push({
      ruleSetId: ours.activeRuleSetId,
      ruleSetName: ruleSets.find((set) => set.id === ours.activeRuleSetId)?.name ?? ours.activeRuleSetId,
      ruleId: '__set__',
      ruleSource: '活动规则集（两边切换到了不同规则集）',
      kind: 'special',
      ours: { enabled: true, output: ours.activeRuleSetId, source: '', suspicious: false },
      theirs: { enabled: true, output: theirs.activeRuleSetId, source: '', suspicious: false },
      affectedLineNumbers: theirs.lines.map((_, index) => index + 1),
    });
  } else if (theirActiveChanged && !ourActiveChanged) {
    activeRuleSetId = theirs.activeRuleSetId;
  }
  if (!ruleSets.some((set) => set.id === activeRuleSetId)) {
    activeRuleSetId = ruleSets[0]?.id ?? activeRuleSetId;
  }

  // 2. 行三方合并，跳过被规则冲突拦下的行
  const baseLineMap = new Map(base.lines.map((line) => [line.id, line]));
  const ourLineMap = new Map(ours.lines.map((line) => [line.id, line]));
  const existingPending = new Set(ours.pendingChoices.map((choice) => choice.id));
  const existingBlocked = new Set(ours.blockedLines.map((line) => line.id));

  const mergedLines: TextbookLine[] = [];
  const newPendingChoices: PendingChoice[] = [];
  const newBlockedLines: BlockedLine[] = [];
  const processedLineIds = new Set<string>();

  const isLineBlocked = (line: TextbookLine): boolean => {
    if (anySetLevelConflict) return true;
    return line.tokens.some((token) => token.ruleId && conflictingRuleIds.has(token.ruleId));
  };

  theirs.lines.forEach((theirLine, index) => {
    const lineId = theirLine.id;
    processedLineIds.add(lineId);
    const baseLine = baseLineMap.get(lineId);
    const ourLine = ourLineMap.get(lineId);
    const lineNumber = index + 1;

    if (isLineBlocked(theirLine)) {
      if (ourLine) mergedLines.push(ourLine); // 已并好的行留着
      const conflict = report.ruleConflicts.find((item) => item.ruleId !== '__set__' && item.affectedLineNumbers.includes(lineNumber));
      const blockedId = `blocked-${pkg.packageId}-${lineId}`;
      if (!existingBlocked.has(blockedId)) {
        newBlockedLines.push({
          id: blockedId,
          packageId: pkg.packageId,
          lineId,
          lineNumber,
          source: theirLine.source,
          ruleId: conflict?.ruleId ?? '__set__',
          ruleSource: conflict?.ruleSource ?? '规则集整体设置',
          theirsAuthor: pkg.author,
          exportedAt: pkg.exportedAt,
          createdAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (!baseLine) {
      // 对方新增的行：我方也有同 id 则保留我方，否则新增
      if (ourLine) {
        mergedLines.push(ourLine);
      } else {
        mergedLines.push(theirLine);
        report.addedCount += 1;
      }
      report.mergedCount += 1;
      return;
    }

    const ourChanged = Boolean(ourLine && lineSignature(ourLine) !== lineSignature(baseLine));
    const theirChanged = lineSignature(theirLine) !== lineSignature(baseLine);

    if (ourChanged && theirChanged) {
      const oursLine = ourLine!;
      if (lineSignature(oursLine) === lineSignature(theirLine)) {
        // 两边改到一致（含同一份包重复合入）→ 无冲突
        mergedLines.push(oursLine);
        report.mergedCount += 1;
        return;
      }
      // 行冲突：原文按组里那版，校对状态和备注按后交的老师
      const resolved: TextbookLine = {
        ...oursLine,
        source: oursLine.source,
        status: theirLine.status,
        note: theirLine.note,
      };
      mergedLines.push(resolved);

      const pendingId = `pending-${pkg.packageId}-${lineId}`;
      const lineReport: LineConflictReport = {
        lineId,
        lineNumber,
        source: oursLine.source,
        ours: versionOf(oursLine),
        theirs: versionOf(theirLine),
      };
      report.lineConflicts.push(lineReport);

      if (!existingPending.has(pendingId)) {
        newPendingChoices.push({
          id: pendingId,
          packageId: pkg.packageId,
          lineId,
          lineNumber,
          ours: lineReport.ours,
          theirs: lineReport.theirs,
          theirsAuthor: pkg.author,
          exportedAt: pkg.exportedAt,
          createdAt: new Date().toISOString(),
        });
      }
      report.mergedCount += 1;
      return;
    }

    if (theirChanged && !ourChanged) {
      mergedLines.push(theirLine);
      report.mergedCount += 1;
      return;
    }

    // 对方没改：保留我方（或基线）
    mergedLines.push(ourLine ?? theirLine);
  });

  // 我方独有的行：对方删除且我方没动过 → 接受删除；否则保留
  ours.lines.forEach((ourLine) => {
    if (processedLineIds.has(ourLine.id)) return;
    const baseLine = baseLineMap.get(ourLine.id);
    const ourChanged = Boolean(baseLine && lineSignature(ourLine) !== lineSignature(baseLine));
    if (baseLine && !ourChanged) return;
    mergedLines.push(ourLine);
  });

  // 3. 汇总待选、未合上与提交记录
  const pendingChoices = [...ours.pendingChoices, ...newPendingChoices];
  const blockedLines = [...ours.blockedLines, ...newBlockedLines];

  const submission: SubmissionRecord = {
    packageId: pkg.packageId,
    author: pkg.author,
    exportedAt: pkg.exportedAt,
    mergedAt: new Date().toISOString(),
    mergedLineCount: report.mergedCount,
    blockedLineCount: blockedLines.filter((line) => line.packageId === pkg.packageId).length,
    pendingChoiceCount: newPendingChoices.length,
    status: newBlockedLines.length > 0 || anySetLevelConflict ? 'partial' : 'complete',
  };
  const submissions = [submission, ...ours.submissions.filter((record) => record.packageId !== pkg.packageId)].slice(0, 20);

  report.blockedLines = blockedLines.filter((line) => line.packageId === pkg.packageId);
  report.status = submission.status;

  let merged: ProjectState = {
    ...ours,
    activeRuleSetId,
    ruleSets,
    lines: mergedLines,
    pendingChoices,
    blockedLines,
    submissions,
    issues: [],
    updatedAt: new Date().toISOString(),
  };
  merged = analyzeProject(merged);
  // 合并后，本机草稿的“同步点”推进到合并结果，作为下次导出的基线。
  merged = { ...merged, mergeAncestor: cleanStartingState(merged) };

  return { state: merged, report };
}

/** 组长对待选行拍板：采用组里版或老师版。 */
export function resolvePendingChoice(current: ProjectState, choiceId: string, side: 'ours' | 'theirs'): ProjectState {
  const choice = current.pendingChoices.find((item) => item.id === choiceId);
  if (!choice) return current;
  const version = side === 'ours' ? choice.ours : choice.theirs;
  const lines = current.lines.map((line) => (
    line.id === choice.lineId ? { ...line, source: version.source, status: version.status, note: version.note } : line
  ));
  return analyzeProject({
    ...current,
    lines,
    pendingChoices: current.pendingChoices.filter((item) => item.id !== choiceId),
    updatedAt: new Date().toISOString(),
  });
}
