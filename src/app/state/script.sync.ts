// 离线疑问重放：演员离线期间记录的疑问按各自的修订顺序（seq）排队；
// 恢复网络后按 seq 顺序重放。每条疑问记录时带有当时的行文本与版本修订号，
// 晚到的疑问一律按「最新排练版本」重新比对，旧结论不会盖回新稿。

import {
  ActorQuestion,
  OutboxEntry,
  ReplayReport,
  ScriptState,
  ScriptVersion,
} from './script.model';

export interface ReplayOutcome {
  state: ScriptState;
  report: ReplayReport;
}

function toQuestion(entry: OutboxEntry, needsRecheck: boolean): ActorQuestion {
  return {
    id: entry.id,
    seq: entry.seq,
    note: entry.note,
    createdAt: entry.createdAt,
    baseText: entry.baseText,
    baseRevision: entry.baseRevision,
    needsRecheck,
    resolved: false,
  };
}

/**
 * 按 seq 顺序重放发件箱：
 *  - 归属版本不存在：留在发件箱，等版本出现后再放，不丢记录。
 *  - 找不到行：挂到该版本的 orphanedQuestions，记录仍在。
 *  - 行当前文本/修订号与记录时一致：直接落为有效疑问。
 *  - 行已被编剧新稿或裁决改过（晚到）：标记 needsRecheck，按最新版本重新比对。
 */
export function replayOutbox(state: ScriptState, now: number): ReplayOutcome {
  const report: ReplayReport = { applied: 0, recheck: 0, orphaned: 0 };
  if (state.outbox.length === 0) return { state, report };

  const queued = [...state.outbox].sort((a, b) => a.seq - b.seq);
  const undeliverable: OutboxEntry[] = [];
  const working = new Map<string, ScriptVersion>(
    state.versions.map((version) => [version.id, version]),
  );

  const attach = (versionId: string, question: ActorQuestion, stableId: string, orphan: boolean) => {
    const version = working.get(versionId)!;
    let next: ScriptVersion;
    if (orphan) {
      next = { ...version, orphanedQuestions: [...version.orphanedQuestions, question] };
      report.orphaned += 1;
    } else {
      const applyTo = <T extends { stableId: string; questions: ActorQuestion[] }>(items: T[]): T[] =>
        items.map((item) => (item.stableId === stableId
          ? { ...item, questions: [...item.questions, question] }
          : item));
      next = { ...version, lines: applyTo(version.lines), cues: applyTo(version.cues) };
      if (question.needsRecheck) report.recheck += 1; else report.applied += 1;
    }
    working.set(versionId, next);
  };

  for (const entry of queued) {
    if (!working.has(entry.versionId)) {
      // 版本尚未到达（例如切换过存档）：留在发件箱稍后重试。
      undeliverable.push(entry);
      continue;
    }

    const version = working.get(entry.versionId)!;
    const line = version.lines.find((item) => item.stableId === entry.stableId);
    const cue = !line ? version.cues.find((item) => item.stableId === entry.stableId) : undefined;
    const item = line ?? cue;

    if (!item) {
      attach(entry.versionId, toQuestion(entry, false), entry.stableId, true);
      continue;
    }

    // 晚到的疑问：以最新排练版本为准比对；文本或修订号变化都需要重新核对。
    const stale = item.text !== entry.baseText || item.revision !== entry.baseRevision;
    attach(entry.versionId, toQuestion(entry, stale), entry.stableId, false);
  }

  if (report.applied + report.recheck + report.orphaned === 0) {
    return { state, report };
  }

  const versions = state.versions.map((version) => working.get(version.id) ?? version);
  return {
    state: {
      ...state,
      versions,
      outbox: undeliverable,
      lastReplay: { ...report, at: now },
    },
    report,
  };
}
