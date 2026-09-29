/**
 * 领域模型：剧本版本、行结论、待裁决冲突、演员离线疑问。
 */

export type LineStatus = 'pending' | 'accepted' | 'returned';
export type CueStatus = 'pending' | 'accepted' | 'returned';

export interface ScriptLine {
  /** 稳定行标记：跨版本、跨合并保持不变。历史存档迁移时按 角色+顺序 派生。 */
  id: string;
  role: string;
  /** 当前排练稿文本（可能是舞台监督保留的旧文本，也可能是已并入的新文本）。 */
  text: string;
  /** 三路合并基准：上次与编剧稿同步时的文本。text===baseText 表示编剧自同步后未改过。 */
  baseText: string;
  status: LineStatus;
  /** 舞台监督结论所针对的文本快照，用于区分“只给了结论”和“结论之后又改稿”。 */
  decidedText?: string;
  /** 已挂到本行上的演员疑问（含离线重放成功的疑问）。 */
  questions: ActorQuestion[];
}

export interface ScriptCue {
  id: string;
  scene: string;
  text: string;
  status: CueStatus;
}

/** 已挂接到具体行的演员疑问。 */
export interface ActorQuestion {
  id: string;
  actor: string;
  note: string;
  /** 记录疑问时该行的文本；重放时与最新排练稿比对，不同则视为过期。 */
  lineTextAtRecord: string;
  /** 演员记录时所在的修订序号（离线队列按它排序重放）。 */
  revisionSeq: number;
  recordedAt: number;
  /** 重放时发现行文本已变化：疑问只作参考保留，不影响任何结论。 */
  stale?: boolean;
}

/** 离线期间排队、尚未重放的疑问。 */
export interface OutboxQuestion extends ActorQuestion {
  /** 记疑问时所在的排练版本与行；重放按目标版本隔离，切版本不会串。 */
  targetVersionId: string;
  targetLineId: string;
  /** 重放结果；'queued' 尚未重放，'applied' 已挂接，'stale' 已过期，'gone' 行已不存在。 */
  state: 'queued' | 'applied' | 'stale' | 'gone' | 'discarded';
  replayVersionId?: string;
  replayVersionLabel?: string;
}

/** 两边都动过的行：编剧新稿与舞台监督结论冲突，挂起待裁决。 */
export interface MergeConflict {
  lineId: string;
  role: string;
  /** 舞台监督已下结论时排练稿保留的文本。 */
  currentText: string;
  incomingText: string;
  currentStatus: LineStatus;
  incomingBaseText: string;
  playwright: string;
  revisionSeq: number;
  mergedAt: number;
}

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: ScriptLine[];
  cues: ScriptCue[];
  /** 本版本自己的待裁决队列；切到别的版本时这些冲突留在原版本，不串台。 */
  conflicts: MergeConflict[];
  /** 最近一次合并摘要。 */
  lastMerge?: MergeSummary;
  /** 历史存档迁移来的版本保留标记，可正常对比/提词。 */
  legacy?: boolean;
}

export interface MergeSummary {
  playwright: string;
  at: number;
  revisionSeq: number;
  applied: number;
  conflicted: number;
  added: number;
  skipped: number;
}

/** 编剧交来的修订稿里的一行。 */
export interface DraftLine {
  /** 新系统生成的稿带稳定 id；历史存档可能没有 id，由合并器按 角色+顺序 派生。 */
  id?: string;
  role: string;
  text: string;
  /** 编剧稿所依据的基准文本（一般等于行的 baseText）。 */
  baseText: string;
}

export interface PlaywrightDraft {
  playwright: string;
  revisionSeq: number;
  note: string;
  lines: DraftLine[];
}

export interface ScriptState {
  schemaVersion: number;
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  /** 离线疑问队列（全局），每条携带目标版本 id，实现版本隔离。 */
  outbox: OutboxQuestion[];
  /** 全局修订序号，离线记录时各自取号，恢复后按号重放。 */
  revisionSeq: number;
}

/** 老版本本地存档（无 schemaVersion、行无 baseText/稳定标记）。 */
export type LegacyLineShape = Partial<ScriptLine> & { role: string; text: string };
export interface LegacyVersionShape {
  id?: string;
  label?: string;
  playwright?: string;
  note?: string;
  lines: LegacyLineShape[];
  cues?: ScriptCue[];
}
export type LegacyArchiveShape = LegacyVersionShape | { versions: LegacyVersionShape[] };
