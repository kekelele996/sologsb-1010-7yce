import type {
  IncomingPackageRecord,
  LineAlternative,
  LineStatus,
  ProjectState,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

/** 基线：老师领走组稿那一刻的快照，供三路合并判断「双方各自改了什么」。 */
export interface ProjectMemento {
  projectId: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: Array<{ id: string; source: string; status: LineStatus; note: string }>;
  capturedAt: string;
}

export type PackageKind = 'proof' | 'handoff';
export type ExportScope = 'all' | 'odd' | 'even' | 'range';

export interface ProofPackage {
  format: 'braille-atelier/proof';
  version: 1;
  packageId: string;
  teacherName: string;
  exportedAt: string;
  scope: ExportScope;
  lineIds: string[];
  base: ProjectMemento;
  teacher: {
    activeRuleSetId: string;
    ruleSets: RuleSet[];
    lines: Array<{ id: string; source: string; status: LineStatus; note: string }>;
  };
}

export interface HandoffPackage {
  format: 'braille-atelier/handoff';
  version: 1;
  exportedAt: string;
  snapshot: ProjectMemento;
}

export type AnyPackage = ProofPackage | HandoffPackage;

export interface RuleConflict {
  ruleSetId: string;
  ruleSetName: string;
  /** undefined 表示规则集级设置（缩写开关、连字模式）对不上。 */
  ruleId?: string;
  ruleSource?: string;
  detail: string;
  affectedLineIds: string[];
}

export interface MergeReport {
  packageId: string;
  teacherName: string;
  alreadyKnown: boolean;
  merged: number;
  blocked: number;
  pendingAlternatives: number;
  newLines: number;
  deletedLines: number;
  unchanged: number;
  ruleChangesApplied: number;
  conflicts: RuleConflict[];
  blockedLineIds: string[];
  newLineIds: string[];
  deletedLineIds: string[];
  notes: string[];
}

export interface MergeResult {
  state: ProjectState;
  report: MergeReport;
}

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------------------------------- 基线 ---------------------------------- */

export function makeMemento(state: ProjectState): ProjectMemento {
  return {
    projectId: state.id,
    title: state.title,
    author: state.author,
    activeRuleSetId: state.activeRuleSetId,
    ruleSets: structuredClone(state.ruleSets),
    lines: state.lines.map((line) => ({ id: line.id, source: line.source, status: line.status, note: line.note })),
    capturedAt: new Date().toISOString(),
  };
}

function sameMemento(a: ProjectMemento, b: ProjectMemento): boolean {
  return stableJson({ ...a, capturedAt: '' }) === stableJson({ ...b, capturedAt: '' });
}

/* --------------------------------- 规则指纹 -------------------------------- */

const ruleFingerprint = (rule: TranscriptionRule) =>
  [rule.source, rule.output, rule.kind, rule.enabled, rule.suspicious, rule.description].join('');
const setSettingsFingerprint = (set: RuleSet) => `${set.contractions}|${set.hyphenMode}`;
const setRulesFingerprint = (set: RuleSet) => set.rules.map((rule) => `${rule.id}=${ruleFingerprint(rule)}`).sort().join('');

export function ruleSetsMatch(a: RuleSet[], b: RuleSet[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((set) => {
    const other = b.find((item) => item.id === set.id);
    if (!other || other.name !== set.name) return false;
    return setSettingsFingerprint(set) === setSettingsFingerprint(other) && setRulesFingerprint(set) === setRulesFingerprint(other);
  });
}

/** 从已转录的行里找出引用了哪些规则 id（含行原文能匹配到的规则）。 */
function referencedRuleIds(line: TextbookLine, ruleSet: RuleSet): Set<string> {
  const ids = new Set<string>();
  for (const token of line.tokens) {
    if (token.ruleId) ids.add(token.ruleId);
  }
  // token 可能来自旧的转录结果；再按当前规则集对原文做一次包含匹配，确保不漏。
  for (const rule of ruleSet.rules) {
    if (!rule.enabled || !rule.source) continue;
    if (rule.kind === 'punctuation' || rule.kind === 'special' || rule.kind === 'number') continue;
    if (line.source.toLocaleLowerCase().includes(rule.source.toLocaleLowerCase())) ids.add(rule.id);
  }
  return ids;
}

/* ---------------------------------- 打包 ---------------------------------- */

export function scopeLineIds(lines: TextbookLine[], scope: ExportScope, start: number, end: number): string[] {
  return lines
    .map((line, index) => ({ line, ordinal: index + 1 }))
    .filter(({ ordinal }) => {
      if (scope === 'all') return true;
      if (scope === 'odd') return ordinal % 2 === 1;
      if (scope === 'even') return ordinal % 2 === 0;
      return ordinal >= start && ordinal <= end;
    })
    .map(({ line }) => line.id);
}

export function buildProofPackage(state: ProjectState, base: ProjectMemento, teacherName: string, scope: ExportScope, start: number, end: number): ProofPackage {
  const lineIds = scopeLineIds(state.lines, scope, start, end);
  const keep = new Set(lineIds);
  return {
    format: 'braille-atelier/proof',
    version: 1,
    packageId: uid('proof'),
    teacherName,
    exportedAt: new Date().toISOString(),
    scope,
    lineIds,
    base,
    teacher: {
      activeRuleSetId: state.activeRuleSetId,
      ruleSets: structuredClone(state.ruleSets),
      lines: state.lines
        .filter((line) => keep.has(line.id))
        .map((line) => ({ id: line.id, source: line.source, status: line.status, note: line.note })),
    },
  };
}

export function buildHandoffPackage(state: ProjectState): HandoffPackage {
  return { format: 'braille-atelier/handoff', version: 1, exportedAt: new Date().toISOString(), snapshot: makeMemento(state) };
}

/* ---------------------------------- 校验 ---------------------------------- */

const isString = (value: unknown): value is string => typeof value === 'string';

function isMemento(value: unknown): value is ProjectMemento {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return isString(m.projectId) && Array.isArray(m.ruleSets) && Array.isArray(m.lines) && isString(m.activeRuleSetId);
}

export function parsePackage(jsonText: string): AnyPackage {
  const parsed = JSON.parse(jsonText) as { format?: unknown };
  if (!parsed || typeof parsed !== 'object' || !isString(parsed.format)) {
    throw new Error('文件不是 BrailleAtelier 校对包。');
  }
  if (parsed.format === 'braille-atelier/handoff' && isMemento((parsed as HandoffPackage).snapshot)) {
    return parsed as unknown as HandoffPackage;
  }
  if (parsed.format === 'braille-atelier/proof') {
    const pkg = parsed as ProofPackage;
    if (!isString(pkg.packageId) || !isString(pkg.teacherName) || !isMemento(pkg.base)) {
      throw new Error('校对包内容不完整，缺少基线或老师信息。');
    }
    if (!Array.isArray(pkg.lineIds) || !pkg.teacher || !Array.isArray(pkg.teacher.lines)) {
      throw new Error('校对包内容不完整，缺少行数据。');
    }
    return pkg;
  }
  throw new Error('无法识别的文件格式，请用本机导出的校对包。');
}

/** 把老师收到的交接包还原成一份完整工程。 */
export function stateFromHandoff(pkg: HandoffPackage, current: ProjectState): ProjectState {
  const snap = pkg.snapshot;
  return {
    ...structuredClone(current),
    id: snap.projectId,
    title: snap.title,
    author: snap.author,
    activeRuleSetId: snap.activeRuleSetId,
    ruleSets: structuredClone(snap.ruleSets),
    lines: snap.lines.map((line) => ({
      id: line.id,
      source: line.source,
      tokens: [],
      status: line.status,
      note: line.note,
      continuesPrevious: false,
      continuesNext: false,
      alternatives: [],
    })),
    selectedLineId: snap.lines[0]?.id ?? '',
    issues: [],
    versions: [],
    incomingPackages: [],
    lastCheckedAt: snap.capturedAt,
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- 合并 ---------------------------------- */

interface RuleMerge {
  ruleSets: RuleSet[];
  conflicts: RuleConflict[];
  appliedCount: number;
}

/** 三路合并规则集：两边都改了同一条规则且改得不一样，就记为冲突。 */
function mergeRuleSets(base: RuleSet[], group: RuleSet[], teacher: RuleSet[]): RuleMerge {
  const conflicts: RuleConflict[] = [];
  let appliedCount = 0;
  const result = group.map((groupSet) => ({ ...groupSet, rules: groupSet.rules.map((rule) => ({ ...rule })) }));

  for (const baseSet of base) {
    const groupSet = result.find((set) => set.id === baseSet.id);
    const teacherSet = teacher.find((set) => set.id === baseSet.id);
    if (!groupSet) {
      // 组里删了整套：老师没动则随组里，老师还改过则整套带回来（删规则集的入口本应用没有，仅做防御）。
      if (teacherSet && (setSettingsFingerprint(teacherSet) !== setSettingsFingerprint(baseSet) || setRulesFingerprint(teacherSet) !== setRulesFingerprint(baseSet))) {
        result.push(structuredClone(teacherSet));
        appliedCount += 1;
      }
      continue;
    }
    if (!teacherSet) continue; // 老师删了整套，视为老师未在其上工作，沿用组里。

    const conflictingRuleIds = new Set<string>();

    // 规则集级设置
    const baseSettings = setSettingsFingerprint(baseSet);
    const groupSettings = setSettingsFingerprint(groupSet);
    const teacherSettings = setSettingsFingerprint(teacherSet);
    if (groupSettings !== teacherSettings && groupSettings !== baseSettings && teacherSettings !== baseSettings) {
      conflicts.push({
        ruleSetId: baseSet.id,
        ruleSetName: groupSet.name,
        detail: `规则集设置对不上：缩写开关/连字模式双方都改过（组里 ${groupSet.contractions ? '开缩写' : '关缩写'}·${groupSet.hyphenMode === 'cross-line' ? '跨行' : '行内'}；老师 ${teacherSet.contractions ? '开缩写' : '关缩写'}·${teacherSet.hyphenMode === 'cross-line' ? '跨行' : '行内'}）`,
        affectedLineIds: [],
      });
    } else if (teacherSettings !== baseSettings) {
      groupSet.contractions = teacherSet.contractions;
      groupSet.hyphenMode = teacherSet.hyphenMode;
      appliedCount += 1;
    }

    // 逐条规则
    const allRuleIds = new Set([...baseSet.rules.map((rule) => rule.id), ...groupSet.rules.map((rule) => rule.id), ...teacherSet.rules.map((rule) => rule.id)]);
    for (const ruleId of allRuleIds) {
      const baseRule = baseSet.rules.find((rule) => rule.id === ruleId);
      const groupRule = groupSet.rules.find((rule) => rule.id === ruleId);
      const teacherRule = teacherSet.rules.find((rule) => rule.id === ruleId);
      const baseFp = baseRule ? ruleFingerprint(baseRule) : null;
      const groupFp = groupRule ? ruleFingerprint(groupRule) : null;
      const teacherFp = teacherRule ? ruleFingerprint(teacherRule) : null;

      if (baseFp === groupFp) {
        // 只有老师改：直接采用（含老师新增、老师删除）。
        if (teacherFp !== baseFp) {
          if (teacherRule) {
            const index = groupSet.rules.findIndex((rule) => rule.id === ruleId);
            if (index >= 0) groupSet.rules[index] = structuredClone(teacherRule);
            else groupSet.rules.push(structuredClone(teacherRule));
          } else {
            groupSet.rules = groupSet.rules.filter((rule) => rule.id !== ruleId);
          }
          appliedCount += 1;
        }
        continue;
      }
      if (baseFp === teacherFp) continue; // 只有组里改，沿用组里。
      // 双方都从基线改开了
      if (groupFp === teacherFp) continue; // 改成一样，无需冲突。
      conflictingRuleIds.add(ruleId);
      conflicts.push({
        ruleSetId: baseSet.id,
        ruleSetName: groupSet.name,
        ruleId,
        ruleSource: teacherRule?.source ?? groupRule?.source ?? baseRule?.source,
        detail: describeRuleDifference(baseRule, groupRule, teacherRule),
        affectedLineIds: [],
      });
    }
  }

  // 老师新增的整套规则集
  for (const teacherSet of teacher) {
    if (!base.some((set) => set.id === teacherSet.id) && !result.some((set) => set.id === teacherSet.id)) {
      result.push(structuredClone(teacherSet));
      appliedCount += 1;
    }
  }

  return { ruleSets: result, conflicts, appliedCount };
}

function describeRuleDifference(baseRule: TranscriptionRule | undefined, groupRule: TranscriptionRule | undefined, teacherRule: TranscriptionRule | undefined): string {
  if (!groupRule && teacherRule) return `组里删除了规则“${teacherRule.source}”，老师还在修改它。`;
  if (groupRule && !teacherRule) return `老师删除了规则“${groupRule.source}”，组里还在修改它。`;
  if (groupRule && teacherRule) {
    const bits: string[] = [];
    if (groupRule.output !== teacherRule.output) bits.push(`盲文：组里「${groupRule.output}」/老师「${teacherRule.output}」`);
    if (groupRule.enabled !== teacherRule.enabled) bits.push(`启用：组里${groupRule.enabled ? '开' : '关'}/老师${teacherRule.enabled ? '开' : '关'}`);
    if (groupRule.suspicious !== teacherRule.suspicious) bits.push(`可疑标记不同`);
    if (groupRule.source !== teacherRule.source) bits.push(`原文：组里「${groupRule.source}」/老师「${teacherRule.source}」`);
    return `规则“${teacherRule.source || groupRule.source}”双方都改过且不一致（${bits.join('；') || '内容不同'}）。`;
  }
  return `规则“${baseRule?.source ?? ''}”双方都改过且不一致。`;
}

export interface MergeProofOptions {
  analyze: (state: ProjectState) => ProjectState;
  transcribe: (source: string, ruleSet: RuleSet, continuesPrevious?: boolean) => TextbookLine['tokens'];
}

/**
 * 合入一份老师校对包。
 * 已并好的行（记录在 incomingPackages）不会重复处理；被规则冲突挡住的行等重试。
 */
export function mergeProofPackage(current: ProjectState, pkg: ProofPackage, options: MergeProofOptions): MergeResult {
  const { analyze, transcribe } = options;
  const base = pkg.base;
  const now = new Date().toISOString();
  const notes: string[] = [];

  if (base.projectId !== current.id) {
    throw new Error(`校对包属于另一份教材（“${base.title}”），与当前组稿“${current.title}”不是同一份，不能合入。`);
  }

  const known = current.incomingPackages.find((item) => item.packageId === pkg.packageId);
  const alreadyMerged = new Set(known?.mergedLineIds ?? []);
  // 「后交的老师」：与此前其他老师的交包时间相比。同包重交沿用自己的首次到达时间。
  const receivedAt = known?.receivedAt ?? now;
  const otherTeachersLatest = current.incomingPackages
    .filter((item) => item.packageId !== pkg.packageId)
    .map((item) => item.receivedAt)
    .sort()
    .at(-1);
  const isLatestTeacher = !otherTeachersLatest || receivedAt >= otherTeachersLatest;

  const report: MergeReport = {
    packageId: pkg.packageId,
    teacherName: pkg.teacherName,
    alreadyKnown: Boolean(known),
    merged: 0,
    blocked: 0,
    pendingAlternatives: 0,
    newLines: 0,
    deletedLines: 0,
    unchanged: 0,
    ruleChangesApplied: 0,
    conflicts: [],
    blockedLineIds: [],
    newLineIds: [],
    deletedLineIds: [],
    notes,
  };

  /* 1. 规则集三路合并，找出「对不上」的规则 */
  const ruleMerge = mergeRuleSets(base.ruleSets, current.ruleSets, pkg.teacher.ruleSets);
  report.conflicts = ruleMerge.conflicts;
  report.ruleChangesApplied = ruleMerge.appliedCount;

  // 老师切换了规则集：组里没切就跟随老师，组里也切过则各用各的（仅提示，不阻断）。
  let activeRuleSetId = current.activeRuleSetId;
  if (pkg.teacher.activeRuleSetId !== base.activeRuleSetId) {
    if (current.activeRuleSetId === base.activeRuleSetId) {
      activeRuleSetId = pkg.teacher.activeRuleSetId;
      const name = ruleMerge.ruleSets.find((set) => set.id === activeRuleSetId)?.name ?? activeRuleSetId;
      notes.push(`老师改用了规则集“${name}”，组里未切换，已跟随老师。`);
    } else if (current.activeRuleSetId !== pkg.teacher.activeRuleSetId) {
      notes.push('老师与组里切换到了不同的规则集，合入后沿用组里当前的规则集；请组长确认。');
    }
  }

  const activeSet = ruleMerge.ruleSets.find((set) => set.id === activeRuleSetId) ?? ruleMerge.ruleSets[0];
  const setLevelConflict = report.conflicts.find((conflict) => !conflict.ruleId && conflict.ruleSetId === activeSet.id);
  const ruleConflictsInActive = new Set(
    report.conflicts.filter((conflict) => conflict.ruleId && conflict.ruleSetId === activeSet.id).map((conflict) => conflict.ruleId!),
  );
  if (ruleConflictsInActive.size === 0 && !setLevelConflict && report.conflicts.length > 0) {
    notes.push(`另有 ${report.conflicts.length} 处规则分歧不在当前规则集内，不影响本次行合并，已保留组里版本。`);
  }

  /* 2. 确定哪些行被规则冲突挡住（引用了对不上的规则的行） */
  const teacherLines = new Map(pkg.teacher.lines.map((line) => [line.id, line]));
  const baseLines = new Map(base.lines.map((line) => [line.id, line]));

  const isBlockedByRules = (line: TextbookLine): boolean => {
    if (setLevelConflict) return true;
    const refs = referencedRuleIds(line, activeSet);
    for (const id of refs) if (ruleConflictsInActive.has(id)) return true;
    return false;
  };

  /* 3. 逐行三路合并。原文随组里（冲突落选版留待选），状态/备注随后交老师 */
  const mergedIds = new Set<string>(alreadyMerged);
  const blockedIds = new Set<string>(); // 重新判定；规则修好后旧 blocked 行可转 merged
  const teacherLineIdsInOrder = pkg.lineIds.filter((id) => teacherLines.has(id));
  const appendedLineIds: string[] = [];

  let lines = structuredClone(current.lines);

  const transcribeAll = (input: TextbookLine[]): TextbookLine[] =>
    input.map((line, index) => ({
      ...line,
      tokens: transcribe(
        line.source,
        activeSet,
        Boolean(input[index - 1]?.source.trimEnd().endsWith('-')),
      ),
    }));

  for (const lineId of teacherLineIdsInOrder) {
    if (mergedIds.has(lineId)) continue; // 断点续合：已并好的留着
    const teacherLine = teacherLines.get(lineId)!;
    const baseLine = baseLines.get(lineId);
    const currentIndex = lines.findIndex((line) => line.id === lineId);
    const groupLine = currentIndex >= 0 ? lines[currentIndex] : undefined;

    if (!baseLine && !groupLine) {
      // 基线和组里都没有 → 老师在其负责范围内新增的行
      const draft: TextbookLine = {
        id: lineId,
        source: teacherLine.source,
        tokens: transcribe(teacherLine.source, activeSet, false),
        status: teacherLine.status,
        note: teacherLine.note,
        continuesPrevious: false,
        continuesNext: false,
        alternatives: [],
      };
      if (isBlockedByRules(draft)) {
        blockedIds.add(lineId);
        continue;
      }
      lines.push(draft);
      appendedLineIds.push(lineId);
      mergedIds.add(lineId);
      report.newLines += 1;
      continue;
    }

    if (!groupLine) {
      // 基线有、组里没有：组里删了行；老师没删也不恢复（删除随组里），记为已处理。
      mergedIds.add(lineId);
      report.deletedLines += 1;
      continue;
    }

    const nextLine: TextbookLine = { ...groupLine, tokens: transcribe(groupLine.source, activeSet, false), alternatives: [...groupLine.alternatives] };

    // 原文三路合并
    if (baseLine && teacherLine.source !== baseLine.source) {
      if (groupLine.source === baseLine.source) {
        nextLine.source = teacherLine.source; // 只有老师改
      } else if (groupLine.source !== teacherLine.source) {
        // 两边都动过：原文按组里那版，落选那版留待选给组长挑
        const exists = nextLine.alternatives.some((alt) => alt.packageId === pkg.packageId && alt.source === teacherLine.source);
        if (!exists) {
          const alternative: LineAlternative = {
            id: uid('alt'),
            packageId: pkg.packageId,
            teacherName: pkg.teacherName,
            source: teacherLine.source,
            createdAt: pkg.exportedAt,
          };
          nextLine.alternatives.push(alternative);
          report.pendingAlternatives += 1;
        }
      }
    }

    nextLine.tokens = transcribe(nextLine.source, activeSet, false);
    if (isBlockedByRules(nextLine)) {
      blockedIds.add(lineId);
      continue;
    }

    // 状态/备注逐字段三路合并：组里=基线说明只有老师改过 → 取老师；
    // 两边都改过且不同 → 后交老师覆盖先交老师（同包重交不覆盖组长后来的手工修改）。
    let touched = false;
    if (baseLine && teacherLine.status !== baseLine.status && groupLine.status !== teacherLine.status) {
      if (groupLine.status === baseLine.status || (isLatestTeacher && !known)) {
        nextLine.status = teacherLine.status;
        touched = true;
      }
    }
    if (baseLine && teacherLine.note !== baseLine.note && groupLine.note !== teacherLine.note) {
      if (groupLine.note === baseLine.note || (isLatestTeacher && !known)) {
        nextLine.note = teacherLine.note;
        touched = true;
      }
    }
    if (nextLine.source !== groupLine.source || nextLine.alternatives.length !== groupLine.alternatives.length || touched) {
      report.merged += 1;
    } else {
      report.unchanged += 1;
    }

    lines[currentIndex] = nextLine;
    mergedIds.add(lineId);
  }

  // 说清「哪些行 × 哪条规则」对不上：只统计老师负责范围内、本次仍被挡住的行
  if (setLevelConflict || ruleConflictsInActive.size > 0) {
    for (const line of lines) {
      if (!teacherLineIdsInOrder.includes(line.id) || !blockedIds.has(line.id)) continue;
      const refs = referencedRuleIds(line, activeSet);
      for (const conflict of report.conflicts) {
        if (conflict.ruleSetId !== activeSet.id) continue;
        if (!conflict.ruleId || refs.has(conflict.ruleId)) {
          conflict.affectedLineIds.push(line.id);
        }
      }
    }
  }

  report.blockedLineIds = [...blockedIds];
  report.blocked = blockedIds.size;
  report.newLineIds = appendedLineIds;

  // 老师在范围内删除基线行的情况（老师行表里缺失）——当前 UI 不提供跨行删除给老师，忽略。

  /* 4. 重新转录 + 保留合并给出的状态/备注（analyzeProject 可能因错误把状态打回 questionable） */
  const transcribed = transcribeAll(lines);
  let mergedState: ProjectState = {
    ...current,
    activeRuleSetId,
    ruleSets: ruleMerge.ruleSets,
    lines: transcribed,
    updatedAt: now,
  };
  mergedState = analyze(mergedState);

  const finalById = new Map(mergedState.lines.map((line) => [line.id, line]));
  mergedState = {
    ...mergedState,
    lines: mergedState.lines.map((line) => {
      const planned = transcribed.find((item) => item.id === line.id);
      if (!planned || !mergedIds.has(line.id)) return line;
      return { ...line, status: planned.status, note: planned.note, alternatives: planned.alternatives };
    }),
    selectedLineId: finalById.has(current.selectedLineId) ? current.selectedLineId : (mergedState.lines[0]?.id ?? ''),
  };

  /* 5. 更新/写入包记录（同 packageId 只保留一条） */
  const record: IncomingPackageRecord = {
    packageId: pkg.packageId,
    teacherName: pkg.teacherName,
    receivedAt: known?.receivedAt ?? now,
    mergedLineIds: [...mergedIds],
    blockedLineIds: [...blockedIds],
  };
  mergedState = {
    ...mergedState,
    incomingPackages: [record, ...mergedState.incomingPackages.filter((item) => item.packageId !== pkg.packageId)],
  };

  if (report.pendingAlternatives > 0) {
    notes.push(`有 ${report.pendingAlternatives} 行原文双方都改过，已保留组里原文，老师版本放进“待组长挑选”。`);
  }
  if (report.blocked > 0) {
    notes.push(`${report.blocked} 行因规则集对不上暂未合入；已并好的行已保留，修好规则后重新交同一包即可续合。`);
  }

  return { state: mergedState, report };
}

/* --------------------------------- 待选操作 -------------------------------- */

export function adoptAlternative(state: ProjectState, lineId: string, alternativeId: string, options: MergeProofOptions): ProjectState {
  const lines = state.lines.map((line) => {
    if (line.id !== lineId) return line;
    const alternative = line.alternatives.find((item) => item.id === alternativeId);
    if (!alternative) return line;
    return { ...line, source: alternative.source, alternatives: line.alternatives.filter((item) => item.id !== alternativeId) };
  });
  return options.analyze({ ...state, lines, updatedAt: new Date().toISOString() });
}

export function discardAlternative(state: ProjectState, lineId: string, alternativeId: string): ProjectState {
  return {
    ...state,
    lines: state.lines.map((line) =>
      line.id === lineId ? { ...line, alternatives: line.alternatives.filter((item) => item.id !== alternativeId) } : line,
    ),
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------------------------- 其他 ---------------------------------- */

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, current) => {
    if (current && typeof current === 'object') {
      if (seen.has(current)) return undefined;
      seen.add(current);
      if (!Array.isArray(current)) {
        return Object.keys(current).sort().reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (current as Record<string, unknown>)[key];
          return acc;
        }, {});
      }
    }
    return current;
  });
}

export function describeBaseline(base: ProjectMemento | undefined): string {
  if (!base) return '尚未记录组稿基线';
  return `${base.title} · ${new Date(base.capturedAt).toLocaleString('zh-CN')}`;
}

export { sameMemento };
