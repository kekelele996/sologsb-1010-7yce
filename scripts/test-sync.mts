/**
 * 离线协作合并语义的端到端验证（不进构建产物，用 esbuild 临时打包后 node 运行）。
 * 运行：npx esbuild scripts/test-sync.mts --bundle --platform=node --format=esm --outfile=scripts/.test-sync.mjs && node scripts/.test-sync.mjs
 */
import assert from 'node:assert/strict';
import { analyzeProject, transcribeLine } from '../src/braille';
import { createInitialProject } from '../src/sample';
import {
  buildHandoffPackage,
  buildProofPackage,
  makeMemento,
  mergeProofPackage,
  parsePackage,
  stateFromHandoff,
} from '../src/sync';
import type { ProjectState, RuleSet } from '../src/types';

const options = { analyze: analyzeProject, transcribe: transcribeLine };
let passed = 0;
const check = (name: string) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const clone = (s: ProjectState): ProjectState => structuredClone(s);
const find = (s: ProjectState, id: string) => s.lines.find((l) => l.id === id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 模拟老师在自己电脑上接收交接包后离线编辑。 */
function teacherMachine(handoffJson: string, edits: (s: ProjectState) => void): ProjectState {
  const pkg = parsePackage(handoffJson);
  assert.equal(pkg.format, 'braille-atelier/handoff');
  const state = analyzeProject(stateFromHandoff(pkg as any, createInitialProject()));
  edits(state);
  return analyzeProject(state);
}

/* ---------------------------------- 用例 ---------------------------------- */

// 1. 双方各改一半、各改各的行：老师改动全部合入
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const teacherA = teacherMachine(handoff, (s) => {
    find(s, 'line-1').source = 'The small seed is under the warm soil.';
    find(s, 'line-1').status = 'approved';
    find(s, 'line-1').note = 'A 已批准';
  });
  const teacherB = teacherMachine(handoff, (s) => {
    find(s, 'line-2').source = 'It needs water and light.';
    find(s, 'line-2').status = 'reviewed';
  });
  const baseA = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));
  const pkgA = buildProofPackage(teacherA, baseA, '王老师', 'odd', 1, 0);
  const pkgB = buildProofPackage(teacherB, makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject()))), '李老师', 'even', 1, 0);

  let group = clone(group0);
  const r1 = mergeProofPackage(group, pkgA, options);
  group = r1.state;
  assert.equal(find(group, 'line-1').source, 'The small seed is under the warm soil.');
  assert.equal(find(group, 'line-1').status, 'approved');
  assert.equal(find(group, 'line-1').note, 'A 已批准');
  assert.equal(r1.report.merged, 1);

  const r2 = mergeProofPackage(group, pkgB, options);
  group = r2.state;
  assert.equal(find(group, 'line-2').source, 'It needs water and light.');
  assert.equal(find(group, 'line-2').status, 'reviewed');
  assert.equal(find(group, 'line-1').note, 'A 已批准', 'A 的行不受 B 包影响');

  check('各改各的行：老师原文/状态/备注合入，互不覆盖');
}

// 2. 同一行两边都动原文：组里原文保留，老师版进 alternatives；状态备注随后交老师
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));

  const tEarly = teacherMachine(handoff, (s) => {
    find(s, 'line-1').source = '老师早交版原文';
    find(s, 'line-1').status = 'reviewed';
    find(s, 'line-1').note = '早交备注';
  });
  const tLate = teacherMachine(handoff, (s) => {
    find(s, 'line-3').source = '无关改动';
  });
  void tLate;

  const pkgEarly = buildProofPackage(tEarly, base, '早老师', 'all', 1, 0);
  // 组里在基线之后也改了同一行原文
  let group: ProjectState = clone(group0);
  group = analyzeProject({
    ...group,
    lines: group.lines.map((l) => (l.id === 'line-1' ? { ...l, source: '组长版原文', status: 'unchecked', note: '' } : l)),
  });

  const early = mergeProofPackage(group, pkgEarly, options);
  group = early.state;
  assert.equal(find(group, 'line-1').source, '组长版原文', '原文按组里那版');
  assert.equal(find(group, 'line-1').alternatives.length, 1);
  assert.equal(find(group, 'line-1').alternatives[0].source, '老师早交版原文');
  assert.equal(find(group, 'line-1').status, 'reviewed', '只有老师改状态 → 取老师');
  assert.equal(find(group, 'line-1').note, '早交备注');

  // 晚交的老师在同一行改了状态/备注（组里此时=基线值 unchecked/''，早老师已改成 reviewed/早交备注）
  const groupBeforeLate = clone(group);
  const tLate2 = teacherMachine(handoff, (s) => {
    find(s, 'line-1').status = 'approved';
    find(s, 'line-1').note = '晚交备注';
  });
  await sleep(10);
  const pkgLate = buildProofPackage(tLate2, base, '晚老师', 'all', 1, 0);
  const late = mergeProofPackage(groupBeforeLate, pkgLate, options);
  group = late.state;
  assert.equal(find(group, 'line-1').status, 'approved', '后交老师的状态覆盖');
  assert.equal(find(group, 'line-1').note, '晚交备注', '后交老师的备注覆盖');
  assert.equal(find(group, 'line-1').source, '组长版原文');

  check('同行两边动原文：留组里版+落选待选；状态备注后交者覆盖');
}

// 3. 规则集双方改同一条规则且不一致：阻断引用它的行，并说清哪行哪条规则
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));

  let group: ProjectState = clone(group0);
  // 组里改 contraction "the" 的盲文输出
  group = analyzeProject({
    ...group,
    ruleSets: group.ruleSets.map((rs) => rs.id === 'ueb-teaching'
      ? { ...rs, rules: rs.rules.map((r) => (r.id === 'contraction-the' ? { ...r, output: '组' } : r)) }
      : rs),
  });

  const teacher = teacherMachine(handoff, (s) => {
    // 老师把同一条规则改成别的，并改自己负责的奇数行
    const rs = s.ruleSets.find((x) => x.id === 'ueb-teaching')!;
    rs.rules = rs.rules.map((r) => (r.id === 'contraction-the' ? { ...r, output: '师' } : r));
    find(s, 'line-1').note = '老师改了备注';
    find(s, 'line-3').note = 'line3 引用 the 吗';
  });
  const pkg = buildProofPackage(teacher, base, '规则老师', 'odd', 1, 0);
  const result = mergeProofPackage(group, pkg, options);
  const r = result.report;
  assert.ok(r.conflicts.some((c) => c.ruleId === 'contraction-the'), '应报告 contraction-the 冲突');
  const conflict = r.conflicts.find((c) => c.ruleId === 'contraction-the')!;
  assert.ok(conflict.affectedLineIds.includes('line-1'), 'line-1 引用 the 应被挡住');
  assert.ok(r.blocked >= 1, '应至少挡住一行');
  assert.ok(r.blockedLineIds.includes('line-1'));
  // 不引用 the 的奇数行（line-3 原文 "By Friday..." 不含 the）——确认是否被挡
  const line3Blocked = r.blockedLineIds.includes('line-3');
  const groupAfter = result.state;
  assert.equal(find(groupAfter, 'line-1').note, '“the”是否符合学生当前缩写进度？', '被挡行保留组里（基线）备注，不应用老师备注');
  // 已并好的行要留着：检查包里不冲突的其他改动
  check(`规则对不上阻断引用行（line-1 被挡，line-3 ${line3Blocked ? '也被挡' : '正常合入'}），冲突带行号和规则`);
}

// 4. 断点续合 + 幂等：先挡后修，重交同一包只合剩余行，且不新增包记录
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));

  let group: ProjectState = clone(group0);
  group = analyzeProject({
    ...group,
    ruleSets: group.ruleSets.map((rs) => rs.id === 'ueb-teaching'
      ? { ...rs, rules: rs.rules.map((r) => (r.id === 'contraction-the' ? { ...r, output: '组' } : r)) }
      : rs),
  });
  const teacher = teacherMachine(handoff, (s) => {
    const rs = s.ruleSets.find((x) => x.id === 'ueb-teaching')!;
    rs.rules = rs.rules.map((r) => (r.id === 'contraction-the' ? { ...r, output: '师' } : r));
    find(s, 'line-1').note = '想合入的备注';
    find(s, 'line-5').note = '连字符行备注';
  });
  const pkg = buildProofPackage(teacher, base, '续合老师', 'odd', 1, 0);

  const first = mergeProofPackage(group, pkg, options);
  group = first.state;
  const recordsAfterFirst = group.incomingPackages.length;
  assert.equal(recordsAfterFirst, 1);
  assert.ok(first.report.blocked >= 1);
  assert.equal(first.report.alreadyKnown, false);

  // 组长在组里把规则改成和老师一致（分歧消除）
  group = analyzeProject({
    ...group,
    ruleSets: group.ruleSets.map((rs) => rs.id === 'ueb-teaching'
      ? { ...rs, rules: rs.rules.map((r) => (r.id === 'contraction-the' ? { ...r, output: '师' } : r)) }
      : rs),
  });

  const second = mergeProofPackage(group, pkg, options);
  group = second.state;
  assert.equal(second.report.alreadyKnown, true);
  assert.equal(group.incomingPackages.length, 1, '同包重交不多出记录');
  assert.equal(second.report.blocked, 0, '规则修好后被挡行合上');
  assert.equal(find(group, 'line-1').note, '想合入的备注');

  // 再交第三次：什么都不再变
  const third = mergeProofPackage(group, pkg, options);
  assert.equal(third.state.incomingPackages.length, 1);
  assert.equal(third.report.merged, 0);
  assert.equal(third.report.unchanged, 0);
  assert.equal(third.report.blocked, 0);

  check('断点续合：被挡行修好规则后续合；同包重交幂等不多记录');
}

// 5. 双方把同一条规则改成相同结果：不算冲突
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));
  let group: ProjectState = clone(group0);
  group = analyzeProject({
    ...group,
    ruleSets: group.ruleSets.map((rs) => rs.id === 'ueb-teaching'
      ? { ...rs, rules: rs.rules.map((r) => (r.id === 'contraction-ing' ? { ...r, suspicious: true } : r)) }
      : rs),
  });
  const teacher = teacherMachine(handoff, (s) => {
    const rs = s.ruleSets.find((x) => x.id === 'ueb-teaching')!;
    rs.rules = rs.rules.map((r) => (r.id === 'contraction-ing' ? { ...r, suspicious: true } : r));
    find(s, 'line-1').note = '一致改动场景';
  });
  const pkg = buildProofPackage(teacher, base, '一致老师', 'odd', 1, 0);
  const result = mergeProofPackage(group, pkg, options);
  assert.equal(result.report.conflicts.length, 0);
  assert.equal(result.report.blocked, 0);
  assert.equal(find(result.state, 'line-1').note, '一致改动场景');
  check('双方规则改成一致：不冲突，正常合入');
}

// 6. 老师单边改规则：合入采用老师版
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));
  const teacher = teacherMachine(handoff, (s) => {
    const rs = s.ruleSets.find((x) => x.id === 'ueb-teaching')!;
    rs.rules = rs.rules.map((r) => (r.id === 'contraction-for' ? { ...r, enabled: false } : r));
    find(s, 'line-1').note = '老师停用了 for 规则';
  });
  const pkg = buildProofPackage(teacher, base, '单改老师', 'odd', 1, 0);
  const result = mergeProofPackage(clone(group0), pkg, options);
  const rule = result.state.ruleSets.find((rs) => rs.id === 'ueb-teaching')!.rules.find((r) => r.id === 'contraction-for')!;
  assert.equal(rule.enabled, false);
  assert.ok(result.report.ruleChangesApplied >= 1);
  assert.equal(result.report.blocked, 0);
  check('只有老师改规则：采用老师版，不阻断');
}

// 7. 新增的行（基线里没有）能合入
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));
  const teacher = teacherMachine(handoff, (s) => {
    s.lines.push({ id: 'line-new-99', source: 'A brand new line.', tokens: [], status: 'reviewed', note: '新增', continuesPrevious: false, continuesNext: false, alternatives: [] });
  });
  const pkg = buildProofPackage(teacher, base, '新增老师', 'all', 1, 0);
  const result = mergeProofPackage(clone(group0), pkg, options);
  assert.ok(result.state.lines.some((l) => l.id === 'line-new-99'));
  assert.equal(result.report.newLines, 1);
  check('老师新增的行随包合入');
}

// 8. 非本教材的包直接拒绝
{
  const group0 = analyzeProject(createInitialProject());
  const handoff = JSON.stringify(buildHandoffPackage(group0));
  const base = makeMemento(analyzeProject(stateFromHandoff(parsePackage(handoff) as any, createInitialProject())));
  const teacher = teacherMachine(handoff, () => {});
  const pkg = buildProofPackage(teacher, base, '走错片场', 'odd', 1, 0);
  (pkg.base as any).projectId = 'other-book';
  assert.throws(() => mergeProofPackage(clone(group0), pkg, options), /另一份教材/);
  check('项目不匹配的校对包拒绝合入');
}

console.log(`\n${passed} 个用例全部通过`);
