import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, makeRule, outputText, transcribeLine, updateRuleInSet } from './braille';
import { createInitialProject } from './sample';
import {
  adoptAlternative,
  buildHandoffPackage,
  buildProofPackage,
  describeBaseline,
  discardAlternative,
  makeMemento,
  mergeProofPackage,
  parsePackage,
  scopeLineIds,
  stateFromHandoff,
  type ExportScope,
  type HandoffPackage,
  type MergeReport,
  type ProjectMemento,
  type ProofPackage,
} from './sync';
import type { HistoryState, ProofIssue, ProjectState, TextbookLine, VersionSnapshot } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const BASELINE_KEY = 'sologsb-1010-braille-baseline-v1';
const HISTORY_LIMIT = 60;

function emptyLine(id = `line-${Date.now()}`): TextbookLine {
  return { id, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false, alternatives: [] };
}

/** 旧版本本地草稿补齐新字段（alternatives、incomingPackages）。 */
function normalizeProject(state: ProjectState): ProjectState {
  return {
    ...state,
    lines: state.lines.map((line) => ({ ...line, alternatives: Array.isArray(line.alternatives) ? line.alternatives : [] })),
    incomingPackages: Array.isArray(state.incomingPackages) ? state.incomingPackages : [],
  };
}

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: normalizeProject(next),
    future: [],
    lastAction: action.label,
  };
}

function loadInitialState(): ProjectState {
  let state: ProjectState | undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      state = analyzeProject(normalizeProject(JSON.parse(raw) as ProjectState));
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  if (!state) state = createInitialProject();
  // 第一次使用（或旧草稿升级）：把当前组稿存成基线，供老师导出校对包三路合并。
  try {
    if (!localStorage.getItem(BASELINE_KEY)) {
      localStorage.setItem(BASELINE_KEY, JSON.stringify(makeMemento(state)));
    }
  } catch {
    // localStorage 不可用时基线功能静默降级。
  }
  return state;
}

function loadBaseline(): ProjectMemento | undefined {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    return raw ? (JSON.parse(raw) as ProjectMemento) : undefined;
  } catch {
    return undefined;
  }
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
  onAdoptAlternative,
  onDiscardAlternative,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
  onAdoptAlternative: (alternativeId: string) => void;
  onDiscardAlternative: (alternativeId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {line.alternatives.length > 0 && (
          <div class="alternatives-strip">
            {line.alternatives.map((alternative) => (
              <div class="alternative-row" key={alternative.id}>
                <div class="alternative-text">
                  <span class="alternative-tag">待组长挑选 · {alternative.teacherName || '老师'} 版原文</span>
                  <p>{alternative.source || '（空行）'}</p>
                </div>
                <div class="alternative-actions">
                  <md-text-button onClick={(event: MouseEvent) => { event.stopPropagation(); onAdoptAlternative(alternative.id); }}>采用此版</md-text-button>
                  <md-icon-button aria-label="放弃此待选版本" title="放弃此版" onClick={(event: MouseEvent) => { event.stopPropagation(); onDiscardAlternative(alternative.id); }}>×</md-icon-button>
                </div>
              </div>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
  onAdoptAlternative,
  onDiscardAlternative,
}: {
  state: ProjectState;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
  onAdoptAlternative: (lineId: string, alternativeId: string) => void;
  onDiscardAlternative: (lineId: string, alternativeId: string) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
            onAdoptAlternative={(alternativeId) => onAdoptAlternative(line.id, alternativeId)}
            onDiscardAlternative={(alternativeId) => onDiscardAlternative(line.id, alternativeId)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function safeFilename(value: string): string {
  return value.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '') || 'braille-atelier';
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

function MergeDialog({
  onClose,
  onFile,
  report,
  error,
  state,
  onJumpLine,
}: {
  onClose: () => void;
  onFile: (file: File) => void;
  report: MergeReport | null;
  error: string;
  state: ProjectState;
  onJumpLine: (lineId: string) => void;
}) {
  const lineNumber = (lineId: string): number => state.lines.findIndex((line) => line.id === lineId) + 1;
  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-dialog" onClick={(event) => event.stopPropagation()}>
        <div class="modal-head">
          <h2>合入校对包</h2>
          <md-icon-button aria-label="关闭" onClick={onClose}>×</md-icon-button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">选择老师交回的 <code>.proof.json</code> 校对包。同一份包重复提交不会多出记录；被规则挡住的行修好规则后再交同一包即可续合。</p>
          <label class="file-picker">
            <input type="file" accept=".json,application/json" onChange={(event) => {
              const file = (event.currentTarget as HTMLInputElement).files?.[0];
              if (file) onFile(file);
              (event.currentTarget as HTMLInputElement).value = '';
            }} />
            <span>选择校对包文件…</span>
          </label>
          {error && <div class="modal-alert error">{error}</div>}
          {report && (
            <div class="merge-report">
              <div class="merge-report-head">
                <strong>{report.teacherName || '老师'} 的校对包</strong>
                {report.alreadyKnown && <span class="report-badge">续合：只处理上次没合上的行</span>}
              </div>
              <div class="report-metrics">
                <span><b>{report.merged}</b> 行本次合入</span>
                <span><b>{report.unchanged}</b> 行无变化</span>
                <span><b>{report.newLines}</b> 行新增</span>
                <span class={report.blocked ? 'danger' : ''}><b>{report.blocked}</b> 行被挡未合</span>
                <span><b>{report.pendingAlternatives}</b> 版原文待组长挑</span>
                <span><b>{report.ruleChangesApplied}</b> 处规则采用老师版</span>
              </div>
              {report.conflicts.length > 0 && (
                <div class="conflict-list">
                  <p class="conflict-title">规则集对不上，以下行已暂停合入：</p>
                  {report.conflicts.map((conflict, index) => (
                    <div class="conflict-item" key={`${conflict.ruleSetId}-${conflict.ruleId ?? 'settings'}-${index}`}>
                      <strong>「{conflict.ruleSetName}」{conflict.ruleSource ? `规则“${conflict.ruleSource}”` : '规则集设置'}</strong>
                      <p>{conflict.detail}</p>
                      {conflict.affectedLineIds.length > 0 && (
                        <div class="conflict-lines">
                          挡住的行：
                          {conflict.affectedLineIds.map((lineId) => {
                            const ordinal = lineNumber(lineId);
                            return (
                              <button key={lineId} class="line-jump-chip" onClick={() => onJumpLine(lineId)}>
                                第 {ordinal > 0 ? ordinal : '?'} 行
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                  <p class="conflict-hint">请在左边规则面板里统一双方的规则，然后让老师重新交同一份包（或直接再次选择该包文件）续合。</p>
                </div>
              )}
              {report.notes.length > 0 && (
                <ul class="report-notes">
                  {report.notes.map((note, index) => <li key={index}>{note}</li>)}
                </ul>
              )}
              {report.blocked === 0 && report.conflicts.length === 0 && (
                <div class="modal-alert success">本次负责范围内的行已全部处理完毕。</div>
              )}
            </div>
          )}
        </div>
        <div class="modal-foot">
          <md-filled-button onClick={onClose}>完成</md-filled-button>
        </div>
      </div>
    </div>
  );
}

function ExportDialog({
  state,
  baseline,
  onClose,
  onExportProof,
  onExportHandoff,
  onImportHandoff,
}: {
  state: ProjectState;
  baseline: ProjectMemento | undefined;
  onClose: () => void;
  onExportProof: (teacherName: string, scope: ExportScope, start: number, end: number) => string | null;
  onExportHandoff: () => void;
  onImportHandoff: (file: File) => Promise<string | null>;
}) {
  const [mode, setMode] = useState<'proof' | 'handoff'>('proof');
  const [teacherName, setTeacherName] = useState('');
  const [scope, setScope] = useState<ExportScope>('odd');
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(Math.max(1, state.lines.length));
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [importing, setImporting] = useState(false);

  const baselineMismatch = baseline && baseline.projectId !== state.id;
  const previewIds = scopeLineIds(state.lines, scope, start, end);
  const validRange = start >= 1 && end >= start && start <= state.lines.length;

  const submitProof = () => {
    if (!teacherName.trim()) {
      setError('请填写老师姓名。');
      return;
    }
    if (!baseline) {
      setError('本机还没有组稿基线，请先让组长导出「交接包」并在本机导入。');
      return;
    }
    if (baselineMismatch) {
      setError('基线属于另一份教材，不能据此导出；请重新导入该教材的交接包。');
      return;
    }
    if (scope === 'range' && !validRange) {
      setError(`行号范围无效，本教材共 ${state.lines.length} 行。`);
      return;
    }
    const issue = onExportProof(teacherName.trim(), scope, start, end);
    if (issue) {
      setError(issue);
      return;
    }
    setDone(`已导出 ${previewIds.length} 行的校对包，可离线发给组长。`);
  };

  const submitHandoffImport = async (file: File) => {
    setImporting(true);
    setError('');
    const issue = await onImportHandoff(file);
    setImporting(false);
    if (issue) setError(issue);
    else {
      setDone('已载入组里的交接包并设为基线，现在可以离线校对了。');
    }
  };

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-dialog" onClick={(event) => event.stopPropagation()}>
        <div class="modal-head">
          <h2>离线协作包</h2>
          <md-icon-button aria-label="关闭" onClick={onClose}>×</md-icon-button>
        </div>
        <div class="modal-body">
          <div class="mode-tabs">
            <button class={mode === 'proof' ? 'active' : ''} onClick={() => { setMode('proof'); setError(''); setDone(''); }}>老师导出校对包</button>
            <button class={mode === 'handoff' ? 'active' : ''} onClick={() => { setMode('handoff'); setError(''); setDone(''); }}>组长交接包 / 老师接收</button>
          </div>

          {mode === 'proof' && (
            <div class="stack-md">
              <p class="modal-hint">校对包内含：领走时的组稿基线、你负责的课文行（原文/状态/备注）以及当前规则集。组长合入时据此三路合并。</p>
              <md-outlined-text-field label="老师姓名" value={teacherName} onInput={(event: any) => setTeacherName(event.currentTarget.value)} />
              <div>
                <p class="field-label">负责的课文行（两位老师各校对一半）</p>
                <div class="scope-options">
                  <label><input type="radio" name="scope" checked={scope === 'odd'} onChange={() => setScope('odd')} /> 奇数行（第 1、3、5… 行，共 {Math.ceil(state.lines.length / 2)} 行）</label>
                  <label><input type="radio" name="scope" checked={scope === 'even'} onChange={() => setScope('even')} /> 偶数行（第 2、4、6… 行，共 {Math.floor(state.lines.length / 2)} 行）</label>
                  <label><input type="radio" name="scope" checked={scope === 'range'} onChange={() => setScope('range')} /> 自定义行号范围</label>
                  <label><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> 全部 {state.lines.length} 行</label>
                </div>
                {scope === 'range' && (
                  <div class="range-inputs">
                    <md-outlined-text-field label="起始行" type="number" value={String(start)} onInput={(event: any) => setStart(Number(event.currentTarget.value))} />
                    <span>至</span>
                    <md-outlined-text-field label="结束行" type="number" value={String(end)} onInput={(event: any) => setEnd(Number(event.currentTarget.value))} />
                  </div>
                )}
              </div>
              <div class={`baseline-callout ${baselineMismatch ? 'mismatch' : ''}`}>
                <strong>组稿基线</strong>
                <p>{describeBaseline(baseline)}</p>
                {baselineMismatch && <p class="danger-text">基线与当前教材不一致，导出前请在「交接包」页重新接收。</p>}
              </div>
            </div>
          )}

          {mode === 'handoff' && (
            <div class="stack-md">
              <p class="modal-hint">
                分组时组长点「导出整份交接包」发给老师；老师在自己电脑上点「接收交接包」载入，本机即获得完整课文和基线，之后离线校对。
              </p>
              <div class="handoff-block">
                <strong>组长：导出整份组稿</strong>
                <p>把当前整份教材、规则集和校对进度打成交接包（含基线）。</p>
                <md-filled-tonal-button onClick={onExportHandoff}>导出整份交接包</md-filled-tonal-button>
              </div>
              <div class="handoff-block">
                <strong>老师：接收交接包</strong>
                <p>载入后会替换本机草稿并把组稿存成基线，请确认当前工作已备份。</p>
                <label class="file-picker">
                  <input type="file" accept=".json,application/json" disabled={importing} onChange={(event) => {
                    const file = (event.currentTarget as HTMLInputElement).files?.[0];
                    if (file) submitHandoffImport(file);
                    (event.currentTarget as HTMLInputElement).value = '';
                  }} />
                  <span>{importing ? '正在载入…' : '选择组长的交接包…'}</span>
                </label>
              </div>
            </div>
          )}

          {error && <div class="modal-alert error">{error}</div>}
          {done && <div class="modal-alert success">{done}</div>}
        </div>
        <div class="modal-foot">
          <md-text-button onClick={onClose}>关闭</md-text-button>
          {mode === 'proof' && <md-filled-button onClick={submitProof}>导出校对包</md-filled-button>}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const [collabDialog, setCollabDialog] = useState<'none' | 'export' | 'merge'>('none');
  const [baseline, setBaseline] = useState<ProjectMemento | undefined>(() => loadBaseline());
  const [mergeReport, setMergeReport] = useState<MergeReport | null>(null);
  const [mergeError, setMergeError] = useState('');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const handleExportProof = (teacherName: string, scope: ExportScope, start: number, end: number): string | null => {
    if (!baseline) return '本机还没有组稿基线。';
    if (baseline.projectId !== state.id) return '基线属于另一份教材，请重新接收交接包。';
    const pkg = buildProofPackage(state, baseline, teacherName, scope, start, end);
    if (pkg.lineIds.length === 0) return '所选范围内没有课文行。';
    downloadJson(`${safeFilename(state.title)}-${safeFilename(teacherName)}-校对包.proof.json`, pkg);
    return null;
  };

  const handleExportHandoff = () => {
    const pkg = buildHandoffPackage(state);
    downloadJson(`${safeFilename(state.title)}-交接包.handoff.json`, pkg);
  };

  const handleImportHandoff = async (file: File): Promise<string | null> => {
    try {
      const parsed = parsePackage(await readFileAsText(file));
      if (parsed.format !== 'braille-atelier/handoff') {
        return '这不是组长交接包（而是校对包）；老师合稿请使用顶栏的「合入校对包」。';
      }
      const next = analyzeProject(stateFromHandoff(parsed as HandoffPackage, state));
      localStorage.setItem(BASELINE_KEY, JSON.stringify(parsed.snapshot));
      setBaseline(parsed.snapshot);
      restore(next);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : '交接包解析失败。';
    }
  };

  const handleMergeFile = async (file: File) => {
    setMergeError('');
    setMergeReport(null);
    try {
      const parsed = parsePackage(await readFileAsText(file));
      if (parsed.format !== 'braille-atelier/proof') {
        setMergeError('这不是老师校对包（像是组长交接包）。');
        return;
      }
      const pkg = parsed as ProofPackage;
      const { state: next, report } = mergeProofPackage(state, pkg, { analyze: analyzeProject, transcribe: transcribeLine });
      const noChange = report.merged === 0 && report.blocked === 0 && report.pendingAlternatives === 0
        && report.newLines === 0 && report.ruleChangesApplied === 0 && report.alreadyKnown;
      if (!noChange) {
        commit('合入校对包', () => next);
      }
      setMergeReport(report);
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : '校对包解析失败。');
    }
  };

  const handleAdoptAlternative = (lineId: string, alternativeId: string) => {
    commit('采用老师待选原文', (current) => adoptAlternative(current, lineId, alternativeId, { analyze: analyzeProject, transcribe: transcribeLine }));
  };

  const handleDiscardAlternative = (lineId: string, alternativeId: string) => {
    commit('放弃待选原文', (current) => discardAlternative(current, lineId, alternativeId));
  };


  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) });
    });
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ ...emptyLine(`line-import-${Date.now()}-${index}`), source, status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '' })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={() => { setMergeReport(null); setMergeError(''); setCollabDialog('export'); }}>导出校对包</md-outlined-button>
          <md-outlined-button onClick={() => { setMergeReport(null); setMergeError(''); setCollabDialog('merge'); }}>合入校对包</md-outlined-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) }));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            }));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [emptyLine()], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line = emptyLine();
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
          onAdoptAlternative={handleAdoptAlternative}
          onDiscardAlternative={handleDiscardAlternative}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            }));
          }} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>

      {collabDialog === 'export' && (
        <ExportDialog
          state={state}
          baseline={baseline}
          onClose={() => setCollabDialog('none')}
          onExportProof={handleExportProof}
          onExportHandoff={handleExportHandoff}
          onImportHandoff={handleImportHandoff}
        />
      )}
      {collabDialog === 'merge' && (
        <MergeDialog
          state={state}
          report={mergeReport}
          error={mergeError}
          onClose={() => setCollabDialog('none')}
          onFile={handleMergeFile}
          onJumpLine={(lineId) => { selectLine(lineId, true); setCollabDialog('none'); }}
        />
      )}
    </div>
  );
}
