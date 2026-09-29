// 历史存档迁移：旧版没有 schemaVersion、stableId、revision、questions / disputes 等字段。
// 升级后存档照样能打开、对比和进入提词；现有记录一条不丢。

import {
  ActorQuestion,
  Cue,
  CURRENT_SCHEMA_VERSION,
  Dispute,
  OutboxEntry,
  ReviewStatus,
  ScriptLine,
  ScriptState,
  ScriptVersion,
  deriveStableId,
} from './script.model';

interface LegacyItem {
  id?: string;
  role?: string;
  scene?: string;
  text?: string;
  status?: ReviewStatus;
}

interface LegacyVersion {
  id?: string;
  label?: string;
  playwright?: string;
  note?: string;
  lines?: LegacyItem[];
  cues?: LegacyItem[];
}

interface LegacyState {
  versions?: LegacyVersion[];
  activeVersionId?: string;
  rehearsalMode?: boolean;
  online?: boolean;
  outbox?: OutboxEntry[];
  mergeSessions?: ScriptState['mergeSessions'];
  lastQuestionSeq?: number;
}

function normalizeStatus(value: unknown): ReviewStatus {
  return value === 'accepted' || value === 'returned' ? value : 'pending';
}

function migrateQuestions(raw: unknown): ActorQuestion[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<ActorQuestion>[]).map((item, index) => ({
    id: typeof item.id === 'string' ? item.id : `q-legacy-${index}`,
    seq: typeof item.seq === 'number' ? item.seq : index + 1,
    note: typeof item.note === 'string' ? item.note : '',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    baseText: typeof item.baseText === 'string' ? item.baseText : '',
    baseRevision: typeof item.baseRevision === 'number' ? item.baseRevision : 0,
    needsRecheck: item.needsRecheck === true,
    resolved: item.resolved === true,
  }));
}

function migrateLine(raw: LegacyItem, recovered: { count: number }, seen: Set<string>): ScriptLine {
  const text = typeof raw.text === 'string' ? raw.text : '';
  const role = typeof raw.role === 'string' ? raw.role : '';
  let stableId = deriveStableId('line', text, role);
  if (seen.has(stableId)) {
    // 同角色同文本的重复行：退化为按旧 id/序号派生，保证稳定且唯一。
    stableId = deriveStableId('line', `${text}#${raw.id ?? seen.size}`, role);
  }
  seen.add(stableId);
  recovered.count += 1;
  const status = normalizeStatus(raw.status);
  return {
    id: typeof raw.id === 'string' ? raw.id : stableId,
    stableId,
    role,
    text,
    status,
    revision: 1,
    priorDecision: status === 'accepted' || status === 'returned'
      ? { decision: status, at: 0 }
      : undefined,
    questions: migrateQuestions((raw as { questions?: unknown }).questions),
    disputed: (raw as { disputed?: boolean }).disputed === true,
  };
}

function migrateCue(raw: LegacyItem, recovered: { count: number }, seen: Set<string>): Cue {
  const text = typeof raw.text === 'string' ? raw.text : '';
  const scene = typeof raw.scene === 'string' ? raw.scene : '';
  let stableId = deriveStableId('cue', text, scene);
  if (seen.has(stableId)) {
    stableId = deriveStableId('cue', `${text}#${raw.id ?? seen.size}`, scene);
  }
  seen.add(stableId);
  recovered.count += 1;
  const status = normalizeStatus(raw.status);
  return {
    id: typeof raw.id === 'string' ? raw.id : stableId,
    stableId,
    scene,
    text,
    status,
    revision: 1,
    priorDecision: status === 'accepted' || status === 'returned'
      ? { decision: status, at: 0 }
      : undefined,
    questions: migrateQuestions((raw as { questions?: unknown }).questions),
    disputed: (raw as { disputed?: boolean }).disputed === true,
  };
}

function migrateVersion(raw: LegacyVersion, index: number, recovered: { count: number }): ScriptVersion {
  const seenLines = new Set<string>();
  const seenCues = new Set<string>();
  const disputes = Array.isArray((raw as { disputes?: Dispute[] }).disputes)
    ? ((raw as { disputes: Dispute[] }).disputes)
    : [];
  const orphanedQuestions = migrateQuestions((raw as { orphanedQuestions?: unknown }).orphanedQuestions);
  return {
    id: typeof raw.id === 'string' ? raw.id : `v-legacy-${index + 1}`,
    label: typeof raw.label === 'string' ? raw.label : `历史存档 ${index + 1}`,
    playwright: typeof raw.playwright === 'string' ? raw.playwright : '未知编剧',
    note: typeof raw.note === 'string' ? raw.note : '由旧版存档迁移而来。',
    lines: (raw.lines ?? []).map((line) => migrateLine(line, recovered, seenLines)),
    cues: (raw.cues ?? []).map((cue) => migrateCue(cue, recovered, seenCues)),
    revision: typeof (raw as { revision?: unknown }).revision === 'number'
      ? ((raw as { revision: number }).revision)
      : 1,
    disputes,
    orphanedQuestions,
  };
}

/** 迁移任意旧快照；幂等：已经是当前 schema 时原样返回。 */
export function migrateState(parsed: unknown): { state: ScriptState; recoveredStableIds: number } {
  if (
    parsed && typeof parsed === 'object'
    && (parsed as Partial<ScriptState>).schemaVersion === CURRENT_SCHEMA_VERSION
  ) {
    return { state: parsed as ScriptState, recoveredStableIds: 0 };
  }
  const raw = (parsed ?? {}) as LegacyState & Partial<ScriptState>;
  const recovered = { count: 0 };
  const versions = (raw.versions ?? []).map((version, index) => migrateVersion(version, index, recovered));
  const state: ScriptState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    versions,
    activeVersionId: typeof raw.activeVersionId === 'string' && versions.some((v) => v.id === raw.activeVersionId)
      ? raw.activeVersionId
      : versions[0]?.id ?? 'v12',
    rehearsalMode: raw.rehearsalMode === true,
    online: raw.online !== false,
    outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
    mergeSessions: Array.isArray(raw.mergeSessions) ? raw.mergeSessions : [],
    lastQuestionSeq: typeof raw.lastQuestionSeq === 'number' ? raw.lastQuestionSeq : 0,
  };
  return { state, recoveredStableIds: recovered.count };
}
