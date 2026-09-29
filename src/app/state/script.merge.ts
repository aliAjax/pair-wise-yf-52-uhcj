// 三方合并引擎：排练版本（target，含舞台监督逐条结论）← 编剧新稿（source），共同祖先 base。
//
// 裁决规则（台词与舞台提示一致）：
//  - 编剧没动过的行：保留舞台监督原来的结论（accepted/returned/pending 全部原样保留）。
//  - 只有编剧动过：采纳新文本，行回到 pending 交舞台监督复审。
//  - 两边都动过（舞台监督已有采纳/退回结论，编剧又改了）：
//    不覆盖舞台监督的退回/采纳结论，挂成「待裁决」，保留双方文本与原结论。
//  - 编剧删掉的行：无结论直接移除；有结论挂「删除待裁决」。
//  - 编剧新增的行：以 pending 进入排练版本。

import {
  ActorQuestion,
  Cue,
  Dispute,
  MergeReport,
  ReviewItem,
  ScriptLine,
  ScriptVersion,
} from './script.model';

export interface MergeInput {
  target: ScriptVersion;
  source: ScriptVersion;
  /** 共同祖先文本：stableId → text；缺项视为祖先中不存在（新增行）。 */
  baseLines: Record<string, string>;
  baseCues: Record<string, string>;
  now: number;
}

export interface MergeOutcome {
  version: ScriptVersion;
  report: MergeReport;
}

type MergeKind = 'line' | 'cue';

interface SideResult<T extends ReviewItem> {
  items: T[];
  disputes: Dispute[];
  orphaned: ActorQuestion[];
  changed: boolean;
}

function findOpenDispute(disputes: Dispute[], stableId: string): Dispute | undefined {
  return disputes.find((dispute) => dispute.stableId === stableId && dispute.status === 'open');
}

function mergeSide<T extends ReviewItem>(
  targetItems: T[],
  sourceItems: T[],
  baseTexts: Record<string, string>,
  disputes: Dispute[],
  orphaned: ActorQuestion[],
  kind: MergeKind,
  now: number,
  report: MergeReport,
): SideResult<T> {
  const writer = new Map(sourceItems.map((item) => [item.stableId, item]));
  let nextDisputes = disputes;
  let nextOrphaned = orphaned;
  const items: T[] = [];
  let changed = false;

  const raiseDispute = (targetItem: T, writerItem: T | undefined, deletion: boolean) => {
    const existing = findOpenDispute(nextDisputes, targetItem.stableId);
    const priorDecision = targetItem.priorDecision?.decision
      ?? (targetItem.status === 'returned' ? 'returned' as const : 'accepted' as const);
    const dispute: Dispute = {
      id: existing?.id ?? `d-${targetItem.stableId}-${now}`,
      stableId: targetItem.stableId,
      kind,
      kindLabel: kind === 'line' ? '台词' : '舞台提示',
      role: kind === 'line' ? (targetItem as unknown as ScriptLine).role : '',
      scene: kind === 'cue' ? (targetItem as unknown as Cue).scene : '',
      rehearsalText: targetItem.text,
      writerText: writerItem?.text ?? '',
      priorDecision,
      deletion,
      status: 'open',
    };
    if (existing) {
      nextDisputes = nextDisputes.map((item) => (item.id === existing.id ? dispute : item));
    } else {
      nextDisputes = [...nextDisputes, dispute];
      report.disputes += 1;
    }
  };

  for (const targetItem of targetItems) {
    const writerItem = writer.get(targetItem.stableId);
    writer.delete(targetItem.stableId);
    const hasBase = Object.prototype.hasOwnProperty.call(baseTexts, targetItem.stableId);
    const baseText = hasBase ? baseTexts[targetItem.stableId] : targetItem.text;
    const writerDeleted = !writerItem;
    const writerEdited = !!writerItem && writerItem.text !== targetItem.text && writerItem.text !== baseText;
    const targetDecided = targetItem.status === 'accepted' || targetItem.status === 'returned';

    // 编剧删行
    if (writerDeleted) {
      if (targetDecided) {
        raiseDispute(targetItem, undefined, true);
        items.push({ ...targetItem, disputed: true });
      } else {
        // 无结论行随新稿移除；疑问不丢，转入版本孤儿疑问。
        nextOrphaned = [...nextOrphaned, ...targetItem.questions];
      }
      report.deleted += 1;
      changed = true;
      continue;
    }

    if (!writerEdited) {
      // 编剧没动过（或与排演稿一致）：舞台监督原结论与记录原样保留。
      items.push(targetItem);
      report.unchanged += 1;
      continue;
    }

    // 编剧改了文本：舞台监督已有结论 → 待裁决；否则自动并入并交复审。
    if (targetDecided) {
      raiseDispute(targetItem, writerItem, false);
      items.push({ ...targetItem, disputed: true });
    } else {
      items.push({
        ...targetItem,
        text: writerItem.text,
        revision: targetItem.revision + 1,
        status: 'pending',
        priorDecision: undefined,
        disputed: false,
        questions: targetItem.questions.map((question) => ({
          ...question,
          needsRecheck: question.baseText !== writerItem.text,
        })),
      });
    }
    report.updated += 1;
    changed = true;
  }

  // 编剧新增的行
  for (const added of writer.values()) {
    items.push({ ...added, revision: 1, status: 'pending', priorDecision: undefined, disputed: false, questions: [] });
    report.added += 1;
    changed = true;
  }

  return { items, disputes: nextDisputes, orphaned: nextOrphaned, changed };
}

/** 执行一次三方合并，返回更新后的版本（原版本不可变）。 */
export function mergeWriterDraft(input: MergeInput): MergeOutcome {
  const report: MergeReport = { unchanged: 0, updated: 0, added: 0, deleted: 0, disputes: 0 };
  const lineResult = mergeSide(
    input.target.lines,
    input.source.lines,
    input.baseLines,
    input.target.disputes,
    input.target.orphanedQuestions,
    'line',
    input.now,
    report,
  );
  const cueResult = mergeSide(
    input.target.cues,
    input.source.cues,
    input.baseCues,
    lineResult.disputes,
    lineResult.orphaned,
    'cue',
    input.now,
    report,
  );

  const version: ScriptVersion = {
    ...input.target,
    lines: lineResult.items,
    cues: cueResult.items,
    disputes: cueResult.disputes,
    orphanedQuestions: cueResult.orphaned,
    revision: input.target.revision + (lineResult.changed || cueResult.changed ? 1 : 0),
  };
  return { version, report };
}

// ---- 待裁决处理 ----------------------------------------------------------

/**
 * 舞台监督对一条待裁决作出决定。
 *  - keepRehearsal：保留排演稿文本与原结论，争议解除（编剧新文本不进入）。
 *  - takeWriter：采用编剧文本（删除争议则移除该行），文本变化抬升修订号并回到 pending 复审；
 *    原退回决定不会被静默抹掉，保存在 priorDecision 里可追溯。
 */
export function resolveDispute(
  version: ScriptVersion,
  disputeId: string,
  outcome: 'keepRehearsal' | 'takeWriter',
  now: number,
): ScriptVersion {
  const dispute = version.disputes.find((item) => item.id === disputeId && item.status === 'open');
  if (!dispute) return version;

  let lines = version.lines;
  let cues = version.cues;
  let revision = version.revision;
  let orphaned = version.orphanedQuestions;

  if (dispute.kind === 'line') {
    if (outcome === 'takeWriter') {
      if (dispute.deletion) {
        const removed = version.lines.find((item) => item.stableId === dispute.stableId);
        if (removed) orphaned = [...orphaned, ...removed.questions];
        lines = version.lines.filter((item) => item.stableId !== dispute.stableId);
      } else {
        lines = version.lines.map((item) => (item.stableId === dispute.stableId
          ? {
              ...item,
              text: dispute.writerText,
              revision: item.revision + 1,
              status: 'pending' as const,
              // 原结论留痕，绝不静默覆盖退回决定。
              priorDecision: { decision: dispute.priorDecision, at: now },
              disputed: false,
              questions: item.questions.map((question) => ({
                ...question,
                needsRecheck: question.baseText !== dispute.writerText,
              })),
            }
          : item));
      }
      revision += 1;
    } else {
      lines = version.lines.map((item) => (item.stableId === dispute.stableId ? { ...item, disputed: false } : item));
    }
  } else if (outcome === 'takeWriter') {
    if (dispute.deletion) {
      const removed = version.cues.find((item) => item.stableId === dispute.stableId);
      if (removed) orphaned = [...orphaned, ...removed.questions];
      cues = version.cues.filter((item) => item.stableId !== dispute.stableId);
    } else {
      cues = version.cues.map((item) => (item.stableId === dispute.stableId
        ? {
            ...item,
            text: dispute.writerText,
            revision: item.revision + 1,
            status: 'pending' as const,
            priorDecision: { decision: dispute.priorDecision, at: now },
            disputed: false,
            questions: item.questions.map((question) => ({
              ...question,
              needsRecheck: question.baseText !== dispute.writerText,
            })),
          }
        : item));
    }
    revision += 1;
  } else {
    cues = version.cues.map((item) => (item.stableId === dispute.stableId ? { ...item, disputed: false } : item));
  }

  const disputes = version.disputes.map((item) => (item.id === disputeId
    ? { ...item, status: 'resolved' as const, outcome, resolvedAt: now }
    : item));

  return { ...version, lines, cues, disputes, revision, orphanedQuestions: orphaned };
}
