import { createReducer, on } from '@ngrx/store';
import {
  activateVersion,
  addVersion,
  discardOutboxItem,
  importLegacyArchive,
  mergePlaywrightDraft,
  recordQuestion,
  replayQuestions,
  resolveLineConflict,
  reviewCue,
  reviewLine,
  setOnline,
  toggleRehearsal,
} from './script.actions';
import {
  loadState,
  mergeDraftIntoVersion,
  migrateState,
  replayOutbox,
  resolveConflict,
} from './script.merge';
import { ActorQuestion, LegacyVersionShape, OutboxQuestion, ScriptState, ScriptVersion } from './script.model';

function activeVersion(state: ScriptState): ScriptVersion | undefined {
  return state.versions.find((version) => version.id === state.activeVersionId);
}

function patchActiveVersion(state: ScriptState, patch: (version: ScriptVersion) => ScriptVersion): ScriptState {
  return {
    ...state,
    versions: state.versions.map((version) => (version.id === state.activeVersionId ? patch(version) : version)),
  };
}

/** 下结论时记录结论针对的文本快照，供下一轮三路合并判断“两边都动过”。 */
function applyLineDecision(version: ScriptVersion, id: string, decision: ScriptVersion['lines'][number]['status']): ScriptVersion {
  return {
    ...version,
    lines: version.lines.map((line) =>
      line.id === id ? { ...line, status: decision, decidedText: decision === 'pending' ? undefined : line.text } : line,
    ),
  };
}

export const scriptReducer = createReducer(
  loadState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) =>
    state.versions.some((version) => version.id === id) ? { ...state, activeVersionId: id } : state,
  ),

  on(reviewLine, (state, { id, decision }) =>
    state.activeVersionId ? patchActiveVersion(state, (version) => applyLineDecision(version, id, decision)) : state,
  ),
  on(reviewCue, (state, { id, decision }) =>
    patchActiveVersion(state, (version) => ({
      ...version,
      cues: version.cues.map((cue) => (cue.id === id ? { ...cue, status: decision } : cue)),
    })),
  ),

  on(mergePlaywrightDraft, (state, { draft }) => {
    const current = activeVersion(state);
    if (!current) return state;
    const result = mergeDraftIntoVersion(current, draft);
    return {
      ...state,
      revisionSeq: Math.max(state.revisionSeq, draft.revisionSeq + 1),
      versions: state.versions.map((version) => (version.id === current.id ? result.version : version)),
    };
  }),
  on(resolveLineConflict, (state, { lineId, choice }) =>
    patchActiveVersion(state, (version) => resolveConflict(version, lineId, choice)),
  ),

  on(recordQuestion, (state, { lineId, actor, note }) => {
    const version = activeVersion(state);
    const line = version?.lines.find((item) => item.id === lineId);
    if (!version || !line) return state;

    const seq = state.revisionSeq;
    const base: ActorQuestion = {
      id: `q-${seq}-${stableShortId()}`,
      actor,
      note,
      lineTextAtRecord: line.text,
      revisionSeq: seq,
      recordedAt: Date.now(),
    };

    if (state.online) {
      // 在线：疑问立即挂到当前版本的行上。
      return {
        ...patchActiveVersion(state, (item) => ({
          ...item,
          lines: item.lines.map((target) =>
            target.id === lineId ? { ...target, questions: [...target.questions, { ...base }] } : target,
          ),
        })),
        revisionSeq: seq + 1,
      };
    }

    // 离线：排队，携带目标版本/行与记录时的修订序号，恢复后按号重放。
    const queued: OutboxQuestion = {
      ...base,
      targetVersionId: version.id,
      targetLineId: lineId,
      state: 'queued',
    };
    return { ...state, outbox: [...state.outbox, queued], revisionSeq: seq + 1 };
  }),
  on(replayQuestions, (state) => replayOutbox(state).state),
  on(discardOutboxItem, (state, { id }) => ({
    ...state,
    outbox: state.outbox.map((item) => (item.id === id ? { ...item, state: 'discarded' as const } : item)),
  })),

  on(importLegacyArchive, (state, { archive }) => {
    const rawVersions: LegacyVersionShape[] = Array.isArray((archive as { versions?: LegacyVersionShape[] }).versions)
      ? (archive as { versions: LegacyVersionShape[] }).versions
      : [archive as LegacyVersionShape];
    // 借迁移器整体走一遍，保证无标记行补派稳定 id、baseText 回填。
    const migrated = migrateState({ versions: rawVersions });
    // 避免 id 与现有版本碰撞。
    const versions = migrated.versions.map((version, index) =>
      state.versions.some((item) => item.id === version.id)
        ? { ...version, id: `${version.id}-imp-${Date.now().toString(36)}-${index}` }
        : version,
    );
    return { ...state, versions: [...state.versions, ...versions], activeVersionId: versions[versions.length - 1]?.id ?? state.activeVersionId };
  }),

  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => {
    if (!online || !state.outbox.some((item) => item.state === 'queued')) return { ...state, online };
    // 浏览器恢复在线的瞬间自动按修订序号重放离线疑问。
    const replayed = replayOutbox({ ...state, online });
    return { ...replayed.state, online };
  }),
);

function stableShortId(): string {
  // 仅用于生成不冲突的疑问 id；内容归属由 revisionSeq 保证。
  return Math.random().toString(36).slice(2, 8);
}
