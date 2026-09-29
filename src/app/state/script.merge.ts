/**
 * 纯函数：三路合并、离线疑问重放、历史存档迁移。
 * 不依赖 Store / Angular，便于单测与复用。
 */
import {
  ActorQuestion,
  DraftLine,
  LegacyArchiveShape,
  LegacyVersionShape,
  LineStatus,
  MergeConflict,
  PlaywrightDraft,
  ScriptLine,
  ScriptState,
  ScriptVersion,
} from './script.model';

export const CURRENT_SCHEMA_VERSION = 2;
const STORAGE_KEY = 'yf52-script-state';

/* ------------------------------------------------------------------ */
/* 三路合并：把编剧新稿并进某个排练版本                                  */
/* ------------------------------------------------------------------ */

export interface MergeResult {
  version: ScriptVersion;
  applied: number;
  conflicted: number;
  added: number;
  skipped: number;
}

/**
 * 以 line.baseText 为共同基准做三路合并：
 * - 编剧稿文本 === 基准：编剧没动 → 整行（含舞台监督结论）原样保留。
 * - 编剧改了，但本行还没有结论（pending 且无 decidedText）→ 自动采纳新文本，
 *   基准推进到新文本（这条结论本就是给“待定行”的，不存在盖掉谁）。
 * - 编剧改了，且舞台监督已采纳/退回（或已对旧文本下过结论）→ 挂冲突待裁决，
 *   排练稿文本与结论一律不动，绝不直接用新稿盖掉退回决定。
 * - 基准在排练稿里找不到对应行 → 新增行。
 * - 编剧删掉基准行不在本函数处理范围（只合并提交的行）。
 */
export function mergeDraftIntoVersion(version: ScriptVersion, draft: PlaywrightDraft, now = Date.now()): MergeResult {
  const byBase = new Map<string, ScriptLine>();
  version.lines.forEach((line) => byBase.set(line.baseText, line));
  const byId = new Map(version.lines.map((line) => [line.id, line]));
  const existingConflictIds = new Set(version.conflicts.map((conflict) => conflict.lineId));

  let applied = 0;
  let conflicted = 0;
  let added = 0;
  let skipped = 0;
  const newConflicts: MergeConflict[] = [];
  /** 需要自动并入文本的行 id → 新文本。 */
  const incomingByLineId = new Map<string, string>();
  /** 排练稿中不存在、需要新增的稿行。 */
  const linesToAdd: DraftLine[] = [];

  draft.lines.forEach((draftLine) => {
    const target = (draftLine.id && byId.get(draftLine.id)) || byBase.get(draftLine.baseText);

    if (!target) {
      // 排练稿里没有对应行：无论文本是否等于基准，都是编剧新增的行。
      linesToAdd.push(draftLine);
      added += 1;
      return;
    }

    // 编剧没动过这行：整行（含舞台监督结论）原样保留。
    if (draftLine.text === target.baseText) {
      skipped += 1;
      return;
    }

    const hasDecision = target.status !== 'pending' || Boolean(target.decidedText);
    if (hasDecision) {
      // 两边都动过：挂待裁决。同一行已挂着未裁决冲突则不重复挂。
      if (!existingConflictIds.has(target.id)) {
        newConflicts.push({
          lineId: target.id,
          role: target.role,
          currentText: target.text,
          incomingText: draftLine.text,
          currentStatus: target.status,
          incomingBaseText: draftLine.baseText,
          playwright: draft.playwright,
          revisionSeq: draft.revisionSeq,
          mergedAt: now,
        });
        existingConflictIds.add(target.id);
      }
      conflicted += 1;
      return;
    }

    // 编剧改了且本行尚无结论：自动并入，基准推进；不存在盖掉谁的结论。
    incomingByLineId.set(target.id, draftLine.text);
    applied += 1;
  });

  const lines: ScriptLine[] = version.lines.map((line) =>
    incomingByLineId.has(line.id)
      ? { ...line, text: incomingByLineId.get(line.id)!, baseText: incomingByLineId.get(line.id)! }
      : line,
  );

  // 新增行追加到末尾，带稳定标记（稿里没 id 就按内容确定性派生）。
  linesToAdd.forEach((draftLine, index) => {
    lines.push({
      id: draftLine.id ?? `line-${stableHash(draftLine.role + '|' + draftLine.text + '|' + index)}`,
      role: draftLine.role,
      text: draftLine.text,
      baseText: draftLine.text,
      status: 'pending',
      questions: [],
    });
  });

  const merged: ScriptVersion = {
    ...version,
    lines,
    conflicts: [...version.conflicts, ...newConflicts],
    lastMerge: { playwright: draft.playwright, at: now, revisionSeq: draft.revisionSeq, applied, conflicted, added, skipped },
  };

  return { version: merged, applied, conflicted, added, skipped };
}

/* ------------------------------------------------------------------ */
/* 待裁决：舞台监督拍板后解决冲突                                        */
/* ------------------------------------------------------------------ */

export function resolveConflict(
  version: ScriptVersion,
  lineId: string,
  choice: 'takeIncoming' | 'keepCurrent',
  now = Date.now(),
): ScriptVersion {
  const conflict = version.conflicts.find((item) => item.lineId === lineId);
  if (!conflict) return version;

  const lines = version.lines.map((line) => {
    if (line.id !== lineId) return line;
    if (choice === 'takeIncoming') {
      // 采纳编剧新稿：文本/基准推进，结论重置为待确认，等舞台监督对新文本重新逐条定性。
      return { ...line, text: conflict.incomingText, baseText: conflict.incomingText, status: 'pending' as LineStatus, decidedText: undefined };
    }
    // 保留排练稿（含退回结论）：仅把基准对齐到编剧新稿，使下次合并不再重复挂起。
    return { ...line, baseText: conflict.incomingText, decidedText: line.text };
  });

  const resolved: ScriptVersion = { ...version, lines, conflicts: version.conflicts.filter((item) => item.lineId !== lineId) };
  if (resolved.lastMerge) resolved.lastMerge = { ...resolved.lastMerge, at: now };
  return resolved;
}

/* ------------------------------------------------------------------ */
/* 离线疑问重放                                                          */
/* ------------------------------------------------------------------ */

export interface ReplayResult {
  state: ScriptState;
  applied: number;
  stale: number;
  gone: number;
}

/**
 * 恢复网络后重放离线疑问队列：
 * - 严格按各自记录的修订序号（revisionSeq）排序，同序按记录时间。
 * - 逐条在“重放那一刻的最新排练版本”上重新比对；因此晚到的疑问会看到先到者
 *   以及期间合并进来的新稿，不会把旧结论盖回去。
 * - 目标行文本与记录时不同 → 标记 stale（过期，只保留作参考）。
 * - 目标版本/行已不存在 → gone（疑问保留在队列里可查，不落到任何行上）。
 */
export function replayOutbox(state: ScriptState): ReplayResult {
  const queued = state.outbox
    .filter((item) => item.state === 'queued')
    .sort((a, b) => a.revisionSeq - b.revisionSeq || a.recordedAt - b.recordedAt);

  let applied = 0;
  let stale = 0;
  let gone = 0;

  // 工作副本：重放过程中逐版本、逐行地更新。
  const versions = state.versions.map((version) => ({ ...version, lines: version.lines.map((line) => ({ ...line, questions: [...line.questions] })) }));
  const outbox = state.outbox.map((item) => ({ ...item }));

  for (const question of queued) {
    const queuedEntry = outbox.find((item) => item.id === question.id)!;
    const version = versions.find((item) => item.id === question.targetVersionId);
    if (!version) {
      queuedEntry.state = 'gone';
      gone += 1;
      continue;
    }
    queuedEntry.replayVersionId = version.id;
    queuedEntry.replayVersionLabel = version.label;

    const line = version.lines.find((item) => item.id === question.targetLineId);
    if (!line) {
      queuedEntry.state = 'gone';
      gone += 1;
      continue;
    }

    // 晚到的疑问对最新排练版本重新比对：文本不同就只作过期参考。
    const isStale = line.text !== question.lineTextAtRecord;
    const attached: ActorQuestion = {
      id: question.id,
      actor: question.actor,
      note: question.note,
      lineTextAtRecord: question.lineTextAtRecord,
      revisionSeq: question.revisionSeq,
      recordedAt: question.recordedAt,
      stale: isStale,
    };
    line.questions.push(attached);
    queuedEntry.state = isStale ? 'stale' : 'applied';
    if (isStale) stale += 1; else applied += 1;
  }

  return { state: { ...state, versions, outbox }, applied, stale, gone };
}

/* ------------------------------------------------------------------ */
/* 历史存档迁移                                                          */
/* ------------------------------------------------------------------ */

/**
 * 升级后照样能打开旧存档：
 * - 无 schemaVersion 的整体存档 / 单个导出的旧版本，都能迁移。
 * - 历史行没有稳定标记：按 版本+角色+出场序号 派生确定性 id，并回填 baseText。
 * - 现有记录（台词、提示、结论）一条不丢；迁移版本打 legacy 标记，照常对比、提词。
 */
export function migrateState(raw: unknown): ScriptState {
  if (!raw || typeof raw !== 'object') return freshState();
  const candidate = raw as Partial<ScriptState>;

  if (Array.isArray(candidate.versions)) {
    const schemaVersion = typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 1;
    const isLegacy = schemaVersion < CURRENT_SCHEMA_VERSION;
    const versions = candidate.versions.map((version, vi) => migrateVersion(version, vi, isLegacy));
    const activeVersionId = versions.some((version) => version.id === candidate.activeVersionId)
      ? candidate.activeVersionId!
      : versions[0]?.id ?? 'v-rehearsal';
    const state: ScriptState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      versions,
      activeVersionId,
      rehearsalMode: Boolean(candidate.rehearsalMode),
      online: candidate.online !== false,
      outbox: Array.isArray(candidate.outbox) ? candidate.outbox : [],
      revisionSeq: typeof candidate.revisionSeq === 'number' ? candidate.revisionSeq : schemaVersion === 1 ? 1 : 0,
    };
    return state;
  }

  // 只导出了一个旧版本的存档。
  const single = migrateVersion(raw as LegacyVersionShape, 0, true);
  return { ...freshState(), versions: [single], activeVersionId: single.id, schemaVersion: CURRENT_SCHEMA_VERSION };
}

function migrateVersion(rawVersion: ScriptVersion | LegacyVersionShape, versionIndex: number, isLegacy: boolean): ScriptVersion {
  const version = rawVersion as Partial<ScriptVersion>;
  const id = version.id || `v-legacy-${versionIndex}`;
  const roleSeen = new Map<string, number>();
  const lines: ScriptLine[] = (version.lines ?? []).map((rawLine) => {
    const seen = (roleSeen.get(rawLine.role) ?? 0) + 1;
    roleSeen.set(rawLine.role, seen);
    const legacyId = rawLine.id || `leg-${stableHash(id + '|' + rawLine.role + '|' + seen)}`;
    const text = rawLine.text;
    const alreadyNew = 'baseText' in rawLine && typeof rawLine.baseText === 'string';
    return {
      id: legacyId,
      role: rawLine.role,
      text,
      baseText: alreadyNew ? (rawLine.baseText as string) : text,
      status: rawLine.status ?? 'pending',
      decidedText: rawLine.decidedText,
      questions: Array.isArray(rawLine.questions) ? rawLine.questions : [],
    };
  });
  return {
    id,
    label: version.label || `历史存档 ${id}`,
    playwright: version.playwright || '未知编剧',
    note: version.note || '由无稳定行标记的历史存档迁移而来，行标记已按角色与出场顺序补派。',
    lines,
    cues: Array.isArray(version.cues) ? version.cues : [],
    conflicts: Array.isArray(version.conflicts) ? version.conflicts : [],
    lastMerge: version.lastMerge,
    legacy: isLegacy,
  };
}

/** 识别单个导出的旧版本文件（{"versions":[...]} 也算）。 */
export function isLegacyArchive(raw: unknown): raw is LegacyArchiveShape {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return Array.isArray(value.lines) || Array.isArray((value as { versions?: unknown }).versions);
}

/* ------------------------------------------------------------------ */
/* 初始数据与存储                                                        */
/* ------------------------------------------------------------------ */

function line(id: string, role: string, text: string, status: LineStatus = 'pending', baseText = text): ScriptLine {
  return { id, role, text, baseText, status, questions: [], decidedText: status === 'pending' ? undefined : text };
}

export function freshState(): ScriptState {
  const rehearsal: ScriptVersion = {
    id: 'v12',
    label: '排练稿 v12',
    playwright: '林编剧',
    note: '当前排练版本：舞台监督已逐条采纳或退回；编剧修订稿到达后在本版本上合并。',
    lines: [
      line('l1', '周岚', '你每次都说等明天，可舞台不会等我们。', 'returned', '你每次都说等明天，可舞台不会等我们。'),
      line('l2', '周野', '那就让灯灭吧，我早已背熟黑暗。', 'accepted'),
      line('l3', '周岚', '看着灯，再说一次你为什么回来。', 'accepted'),
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' },
    ],
    conflicts: [],
  };

  const director: ScriptVersion = {
    id: 'v14',
    label: '导演工作版 v14',
    playwright: '林编剧',
    note: '导演另开的工作版本；在本版产生的待裁决只留在本版。',
    lines: [
      line('l1', '周岚', '你总说明天，但今晚我们必须把话说完。', 'pending'),
      line('l3', '周岚', '看着灯，再说一次你为什么回来。', 'pending'),
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }],
    conflicts: [],
  };

  return { schemaVersion: CURRENT_SCHEMA_VERSION, versions: [rehearsal, director], activeVersionId: 'v12', rehearsalMode: false, online: true, outbox: [], revisionSeq: 1 };
}

/** 编剧侧内置的新稿示例：l1 是“两边都动过”的典型（已退回 + 编剧再改）。 */
export function samplePlaywrightDraft(seq: number): PlaywrightDraft {
  return {
    playwright: '林编剧',
    revisionSeq: seq,
    note: '联排阶段修订：重写周岚开场句；微调周野回应；新增收束句。',
    lines: [
      // 编剧没动 l2 → 合并时保留“已采纳”结论。
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', baseText: '那就让灯灭吧，我早已背熟黑暗。' },
      // l1 已被舞台监督退回，编剧又改 → 必须挂待裁决，不能盖掉退回。
      { id: 'l1', role: '周岚', text: '别再说等明天——幕布拉开的那一刻，我们谁都躲不掉。', baseText: '你每次都说等明天，可舞台不会等我们。' },
      // l3 已采纳但编剧再改 → 同样挂待裁决。
      { id: 'l3', role: '周岚', text: '看着这盏灯，告诉我，你到底为什么回来。', baseText: '看着灯，再说一次你为什么回来。' },
      // 新增行。
      { role: '周野', text: '灯亮着的时候，我从不敢看你的眼睛。', baseText: '' },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 小工具                                                                */
/* ------------------------------------------------------------------ */

/** 确定性 32 位哈希（FNV-1a），用于给历史行派稳定标记，不用随机数。 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function loadState(): ScriptState {
  if (typeof localStorage === 'undefined') return freshState();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? migrateState(JSON.parse(saved)) : freshState();
  } catch (error) {
    console.warn('本地存档无法解析，使用初始数据：', error);
    return freshState();
  }
}

/** 供界面导入编剧稿文件后调用。 */
export function parseDraftFile(text: string): PlaywrightDraft | null {
  try {
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.lines)) return null;
    const lines: DraftLine[] = raw.lines.map((item: { id?: string; role: string; text: string; baseText?: string }) => ({
      id: typeof item.id === 'string' ? item.id : undefined,
      role: String(item.role ?? ''),
      text: String(item.text ?? ''),
      baseText: typeof item.baseText === 'string' ? item.baseText : String(item.text ?? ''),
    }));
    return {
      playwright: String(raw.playwright ?? '外来编剧稿'),
      revisionSeq: typeof raw.revisionSeq === 'number' ? raw.revisionSeq : Date.now(),
      note: String(raw.note ?? ''),
      lines,
    };
  } catch {
    return null;
  }
}

export function persistState(state: ScriptState): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
