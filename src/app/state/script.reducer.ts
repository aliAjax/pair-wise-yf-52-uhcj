import { createReducer, on } from '@ngrx/store';
import {
  activateVersion,
  addVersion,
  editLine,
  importLegacySnapshot,
  mergeWriterDraft,
  recordQuestion,
  removeLine,
  reorderLines,
  replayQuestions,
  reviewCue,
  reviewLine,
  resolveDispute,
  resolveQuestion,
  setOnline,
  toggleRehearsal,
} from './script.actions';
import { migrateState } from './script.migration';
import { mergeWriterDraft as runMerge, resolveDispute as runResolveDispute } from './script.merge';
import { replayOutbox } from './script.sync';
import {
  ActorQuestion,
  CURRENT_SCHEMA_VERSION,
  OutboxEntry,
  ScriptLine,
  ScriptState,
  ScriptVersion,
} from './script.model';

export type { CueDecision, ReviewItem, ReviewStatus } from './script.model';
export type { ActorQuestion, Cue, Dispute, ScriptLine, ScriptState, ScriptVersion } from './script.model';

const now = () => Date.now();

function snapshotTexts(version: ScriptVersion): { lines: Record<string, string>; cues: Record<string, string> } {
  const lines: Record<string, string> = {};
  const cues: Record<string, string> = {};
  version.lines.forEach((line) => { lines[line.stableId] = line.text; });
  version.cues.forEach((cue) => { cues[cue.stableId] = cue.text; });
  return { lines, cues };
}

// 初始数据：v12 是舞台监督正在逐条裁决的排练稿（含已退回结论），v13 是编剧新修订。
const v12: ScriptVersion = {
  id: 'v12',
  label: '排练稿 v12',
  playwright: '林编剧',
  note: '舞台监督逐条裁决中：第二句已退回，灯光提示已采纳。',
  revision: 2,
  lines: [
    {
      id: 'l1', stableId: 'L-v12-l1', role: '周岚',
      text: '你每次都说等明天，可舞台不会等我们。', status: 'accepted', revision: 1,
      priorDecision: { decision: 'accepted', at: 0 }, questions: [],
    },
    {
      id: 'l2', stableId: 'L-v12-l2', role: '周野',
      text: '那就让灯灭吧，我早已背熟黑暗。', status: 'returned', revision: 1,
      priorDecision: { decision: 'returned', at: 0 }, questions: [],
    },
  ],
  cues: [
    { id: 'c1', stableId: 'C-v12-c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending', revision: 1, questions: [] },
    {
      id: 'c2', stableId: 'C-v12-c2', scene: '第三场',
      text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted', revision: 1,
      priorDecision: { decision: 'accepted', at: 0 }, questions: [],
    },
  ],
  disputes: [],
  orphanedQuestions: [],
};

const v13: ScriptVersion = {
  id: 'v13',
  label: '编剧新稿 v13',
  playwright: '林编剧',
  note: '修订第三场：改写两句台词、新增追问；灯光提示改为冷白转琥珀。',
  revision: 1,
  lines: [
    { id: 'l1', stableId: 'L-v12-l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending', revision: 1, questions: [] },
    { id: 'l3', stableId: 'L-v13-l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending', revision: 1, questions: [] },
  ],
  cues: [
    { id: 'c3', stableId: 'C-v13-c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending', revision: 1, questions: [] },
  ],
  disputes: [],
  orphanedQuestions: [],
};

function createInitialState(): ScriptState {
  const fallback: ScriptState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    versions: [v12, v13],
    activeVersionId: 'v12',
    rehearsalMode: false,
    online: true,
    outbox: [],
    mergeSessions: [],
    lastQuestionSeq: 0,
  };
  if (typeof localStorage === 'undefined') return fallback;
  const saved = localStorage.getItem('yf52-script-state');
  if (!saved) return fallback;
  try {
    const parsed = JSON.parse(saved) as unknown;
    const { state, recoveredStableIds } = migrateState(parsed);
    return recoveredStableIds > 0
      ? { ...state, lastMigration: { from: 1, to: CURRENT_SCHEMA_VERSION, recoveredStableIds } }
      : state;
  } catch {
    return fallback;
  }
}

function updateActiveVersion(state: ScriptState, mutate: (version: ScriptVersion) => ScriptVersion): ScriptState {
  return {
    ...state,
    versions: state.versions.map((version) => (version.id === state.activeVersionId ? mutate(version) : version)),
  };
}

function reviewItem<T extends { id: string; status: ScriptLine['status']; priorDecision?: ScriptLine['priorDecision'] }>(
  items: T[],
  id: string,
  decision: 'accepted' | 'returned',
  timestamp: number,
): T[] {
  return items.map((item) => (item.id === id
    ? { ...item, status: decision, priorDecision: { decision, at: timestamp } }
    : item));
}

function bumpTextRevision<T extends { id: string; text: string; revision: number; status: ScriptLine['status']; priorDecision?: ScriptLine['priorDecision'] }>(
  items: T[],
  id: string,
  text: string,
): T[] {
  return items.map((item) => (item.id === id
    ? { ...item, text, revision: item.revision + 1, status: 'pending' as const, priorDecision: undefined }
    : item));
}

export const scriptReducer = createReducer(
  createInitialState(),

  on(addVersion, (state, { version }) => ({
    ...state,
    versions: [...state.versions.filter((item) => item.id !== version.id), version],
  })),

  on(activateVersion, (state, { id }) =>
    (state.versions.some((version) => version.id === id) ? { ...state, activeVersionId: id } : state)),

  on(reviewLine, (state, { id, decision }) =>
    updateActiveVersion(state, (version) => ({
      ...version,
      lines: reviewItem(version.lines, id, decision, now()) as ScriptLine[],
    }))),

  on(reviewCue, (state, { id, decision }) =>
    updateActiveVersion(state, (version) => ({
      ...version,
      cues: reviewItem(version.cues, id, decision as 'accepted' | 'returned', now()),
    }))),

  on(editLine, (state, { id, text }) =>
    updateActiveVersion(state, (version) => ({
      ...version,
      lines: bumpTextRevision(version.lines, id, text),
      revision: version.revision + 1,
    }))),

  on(removeLine, (state, { id }) =>
    updateActiveVersion(state, (version) => {
      const removed = version.lines.find((line) => line.id === id);
      return {
        ...version,
        lines: version.lines.filter((line) => line.id !== id),
        orphanedQuestions: removed ? [...version.orphanedQuestions, ...removed.questions] : version.orphanedQuestions,
        revision: version.revision + 1,
      };
    })),

  on(reorderLines, (state, { from, to }) =>
    updateActiveVersion(state, (version) => {
      if (from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    })),

  on(mergeWriterDraft, (state, { targetVersionId, source, baseVersionId }) => {
    const target = state.versions.find((version) => version.id === targetVersionId);
    const base = state.versions.find((version) => version.id === baseVersionId) ?? target;
    if (!target) return state;
    const baseTexts = snapshotTexts(base);
    const { version: merged, report } = runMerge({
      target,
      source,
      baseLines: baseTexts.lines,
      baseCues: baseTexts.cues,
      now: now(),
    });
    const priorSession = state.mergeSessions.find(
      (session) => session.targetVersionId === targetVersionId && !session.finishedAt,
    );
    const session = {
      targetVersionId,
      sourceVersionId: source.id,
      baseVersionId,
      startedAt: priorSession?.startedAt ?? now(),
      summary: report,
      baseLines: priorSession?.baseLines ?? baseTexts.lines,
      baseCues: priorSession?.baseCues ?? baseTexts.cues,
    };
    return {
      ...state,
      versions: state.versions.map((item) => (item.id === targetVersionId ? merged : item)),
      mergeSessions: [
        ...state.mergeSessions.filter((item) => item.targetVersionId !== targetVersionId || item.finishedAt),
        session,
      ],
      activeVersionId: targetVersionId,
    };
  }),

  on(resolveDispute, (state, { versionId, disputeId, outcome }) => ({
    ...state,
    versions: state.versions.map((version) =>
      (version.id === versionId ? runResolveDispute(version, disputeId, outcome, now()) : version)),
  })),

  on(recordQuestion, (state, { versionId, stableId, note }) => {
    const seq = state.lastQuestionSeq + 1;
    const version = state.versions.find((item) => item.id === versionId);
    const item = version?.lines.find((line) => line.stableId === stableId)
      ?? version?.cues.find((cue) => cue.stableId === stableId);
    if (!version || !item) return state;

    const question: ActorQuestion = {
      id: `q-${seq}`,
      seq,
      note,
      createdAt: now(),
      baseText: item.text,
      baseRevision: version.revision,
      needsRecheck: false,
      resolved: false,
    };

    // 离线：进发件箱，恢复网络后按 seq 重放。
    if (!state.online) {
      const entry: OutboxEntry = {
        id: question.id,
        seq,
        versionId,
        stableId,
        note,
        baseText: item.text,
        baseRevision: version.revision,
        createdAt: question.createdAt,
      };
      return { ...state, lastQuestionSeq: seq, outbox: [...state.outbox, entry] };
    }

    const attach = <T extends { stableId: string; questions: ActorQuestion[] }>(items: T[]): T[] =>
      items.map((entryItem) => (entryItem.stableId === stableId
        ? { ...entryItem, questions: [...entryItem.questions, question] }
        : entryItem));
    return {
      ...state,
      lastQuestionSeq: seq,
      versions: state.versions.map((entryVersion) => (entryVersion.id === versionId
        ? { ...entryVersion, lines: attach(entryVersion.lines), cues: attach(entryVersion.cues) }
        : entryVersion)),
    };
  }),

  on(replayQuestions, (state) => replayOutbox(state, now()).state),

  on(resolveQuestion, (state, { versionId, questionId }) => ({
    ...state,
    versions: state.versions.map((version) => {
      if (version.id !== versionId) return version;
      const settle = (questions: ActorQuestion[]) => questions.map((question) =>
        (question.id === questionId ? { ...question, resolved: true } : question));
      return {
        ...version,
        lines: version.lines.map((line) => ({ ...line, questions: settle(line.questions) })),
        cues: version.cues.map((cue) => ({ ...cue, questions: settle(cue.questions) })),
        orphanedQuestions: settle(version.orphanedQuestions),
      };
    }),
  })),

  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => (online === state.online
    ? state
    : online
      ? replayOutbox({ ...state, online: true }, now()).state
      : { ...state, online: false })),

  on(importLegacySnapshot, (state, { raw }) => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const { state: migrated, recoveredStableIds } = migrateState(parsed);
      return {
        ...migrated,
        online: state.online,
        rehearsalMode: state.rehearsalMode,
        lastMigration: { from: 1, to: CURRENT_SCHEMA_VERSION, recoveredStableIds },
      };
    } catch {
      return state;
    }
  }),
);
