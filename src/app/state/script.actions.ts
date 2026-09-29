import { createAction, props } from '@ngrx/store';
import { LegacyArchiveShape, PlaywrightDraft, ScriptVersion } from './script.model';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());

/** 舞台监督在当前排练版本上对一行下结论（采纳 / 退回 / 重置待确认）。 */
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' | 'pending' }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: 'accepted' | 'returned' | 'pending' }>());

/** 把编剧新稿三路合并进当前激活版本；冲突挂在该版本上。 */
export const mergePlaywrightDraft = createAction('[Script] Merge Playwright Draft', props<{ draft: PlaywrightDraft }>());
/** 舞台监督对一行的待裁决冲突拍板：用编剧新稿，或保留排练稿。 */
export const resolveLineConflict = createAction('[Script] Resolve Line Conflict', props<{ lineId: string; choice: 'takeIncoming' | 'keepCurrent' }>());

/** 演员记疑问：在线直接挂行，离线进重放队列，各自领取修订序号。 */
export const recordQuestion = createAction('[Script] Record Question', props<{ lineId: string; actor: string; note: string }>());
/** 恢复网络后按修订序号顺序重放离线疑问。 */
export const replayQuestions = createAction('[Script] Replay Offline Questions');
export const discardOutboxItem = createAction('[Script] Discard Outbox Item', props<{ id: string }>());

/** 导入无稳定行标记的历史存档，迁移后并入版本列表，记录一条不丢。 */
export const importLegacyArchive = createAction('[Script] Import Legacy Archive', props<{ archive: LegacyArchiveShape }>());

export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());
