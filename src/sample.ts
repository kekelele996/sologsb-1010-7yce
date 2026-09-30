import { analyzeProject } from './braille';
import type { ProjectState, RuleSet, TranscriptionRule } from './types';

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').map<TranscriptionRule>((letter, index) => ({
  id: `letter-${letter}`,
  source: letter,
  output: '⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵'[index],
  kind: 'letter',
  enabled: true,
  suspicious: false,
  description: '拉丁字母基础表',
}));

const punctuation: TranscriptionRule[] = [
  [',', '⠂', '逗号'], ['.', '⠲', '句号'], ['?', '⠦', '问号'], ['!', '⠖', '叹号'], [';', '⠆', '分号'], [':', '⠒', '冒号'], ['-', '⠤', '连字符'],
].map(([source, output, description]) => ({
  id: `punctuation-${source}`,
  source,
  output,
  kind: 'punctuation',
  enabled: true,
  suspicious: false,
  description,
}));

const contractions: TranscriptionRule[] = [
  ['and', '⠯', false, '高频缩写'], ['the', '⠮', false, '高频缩写'], ['for', '⠿', true, '低年级教材可改为完整拼写'],
  ['of', '⠷', false, '高频缩写'], ['with', '⠾', false, '高频缩写'], ['ing', '⠬', true, '词尾缩写'],
  ['ed', '⠫', true, '词尾缩写'], ['er', '⠻', false, '词尾缩写'], ['ch', '⠡', false, '字母组合'], ['sh', '⠩', false, '字母组合'], ['th', '⠹', false, '字母组合'],
].map(([source, output, suspicious, description]) => ({
  id: `contraction-${source}`,
  source: String(source),
  output: String(output),
  kind: 'contraction',
  enabled: true,
  suspicious: Boolean(suspicious),
  description: String(description),
}));

const commonRules: TranscriptionRule[] = [
  { id: 'number-sign', source: '#', output: '⠼', kind: 'number', enabled: true, suspicious: false, description: '数字起始符' },
  { id: 'capital-sign', source: 'capital', output: '⠠', kind: 'special', enabled: true, suspicious: false, description: '大写起始符' },
  ...letters,
  ...punctuation,
];

const ruleSets: RuleSet[] = [
  {
    id: 'ueb-teaching',
    name: 'UEB 教学规则',
    description: '英美盲文教学规则，默认启用常用缩写并将低年级易混淆缩写标为可疑。',
    contractions: true,
    hyphenMode: 'cross-line',
    rules: [...commonRules, ...contractions],
  },
  {
    id: 'literary-standard',
    name: '通用文学盲文',
    description: '保留完整缩写表，适合课外读本和工作表。',
    contractions: true,
    hyphenMode: 'inline',
    rules: [...commonRules, ...contractions.filter((rule) => !rule.suspicious)],
  },
  {
    id: 'spelling-first',
    name: '逐字拼读（无缩写）',
    description: '低年级识字课使用，关闭缩写和跨行连字符压缩。',
    contractions: false,
    hyphenMode: 'inline',
    rules: commonRules,
  },
];

const base: ProjectState = {
  id: 'braille-course-1010',
  title: '春天观察课 · 盲文教材',
  author: '资源教师 / 林老师',
  activeRuleSetId: 'ueb-teaching',
  ruleSets,
  selectedLineId: 'line-1',
  lines: [
    { id: 'line-1', source: 'The small seed is under the soil.', tokens: [], status: 'questionable', note: '“the”是否符合学生当前缩写进度？', continuesPrevious: false, continuesNext: false },
    { id: 'line-2', source: 'It needs water, light and time.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-3', source: 'By Friday, a green shoot appears.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-4', source: 'The gardener said, “Welcome, little sprout!”', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-5', source: 'Look-', tokens: [], status: 'unchecked', note: '下一行是同一单词，检查跨行断词。', continuesPrevious: false, continuesNext: false },
    { id: 'line-6', source: 'ing is learning!', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-7', source: 'Please measure 12 centimetres from the edge.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
  ],
  issues: [],
  versions: [],
  pendingChoices: [],
  blockedLines: [],
  submissions: [],
  lastCheckedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export function createInitialProject(): ProjectState {
  const project = analyzeProject(base);
  // 记录本机草稿起点，作为导出校对包时三方合并的基线。
  const { mergeAncestor: _ancestor, ...startingSnapshot } = project;
  return { ...project, mergeAncestor: startingSnapshot as ProjectState };
}
