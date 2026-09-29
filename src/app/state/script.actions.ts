import { createAction, props } from '@ngrx/store';
import { ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const editLine = createAction('[Script] Edit Line', props<{ id: string; text: string }>());
export const removeLine = createAction('[Script] Remove Line', props<{ id: string }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());

/** 编剧把新稿并入指定排练版本（baseVersionId 为共同祖先，通常即该版本自身）。 */
export const mergeWriterDraft = createAction(
  '[Script] Merge Writer Draft',
  props<{ targetVersionId: string; source: ScriptVersion; baseVersionId: string }>(),
);
export const resolveDispute = createAction(
  '[Script] Resolve Dispute',
  props<{ versionId: string; disputeId: string; outcome: 'keepRehearsal' | 'takeWriter' }>(),
);

/** 演员记录疑问：离线时入发件箱，在线时直接落到行上。 */
export const recordQuestion = createAction(
  '[Script] Record Question',
  props<{ versionId: string; stableId: string; note: string }>(),
);
/** 恢复网络后按 seq 顺序重放发件箱。 */
export const replayQuestions = createAction('[Script] Replay Questions');
export const resolveQuestion = createAction(
  '[Script] Resolve Question',
  props<{ versionId: string; questionId: string }>(),
);

/** 导入没有稳定行标记的历史存档（用于演示/真实恢复），经迁移层升级。 */
export const importLegacySnapshot = createAction('[Script] Import Legacy Snapshot', props<{ raw: string }>());
