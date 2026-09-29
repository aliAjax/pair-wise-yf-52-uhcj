// 版本对比：以 stableId 对齐两侧行（历史存档迁移补齐后同样可对比）。

import { ReviewItem, ScriptVersion } from './script.model';

export type DiffKind = 'added' | 'removed' | 'changed' | 'same';

export interface DiffRow {
  stableId: string;
  kind: 'line' | 'cue';
  title: string;
  baseText: string;
  otherText: string;
  diff: DiffKind;
  baseStatus: string;
  otherStatus: string;
  disputed: boolean;
}

function collect(version: ScriptVersion): Map<string, { item: ReviewItem; kind: 'line' | 'cue'; title: string }> {
  const map = new Map<string, { item: ReviewItem; kind: 'line' | 'cue'; title: string }>();
  version.lines.forEach((item) => map.set(item.stableId, { item, kind: 'line', title: item.role }));
  version.cues.forEach((item) => map.set(item.stableId, { item, kind: 'cue', title: item.scene }));
  return map;
}

export function compareVersions(base: ScriptVersion, other: ScriptVersion): { rows: DiffRow[]; counts: Record<DiffKind, number>; openDisputes: number } {
  const left = collect(base);
  const right = collect(other);
  const rows: DiffRow[] = [];
  const counts: Record<DiffKind, number> = { added: 0, removed: 0, changed: 0, same: 0 };

  for (const [stableId, entry] of right) {
    const peer = left.get(stableId);
    const diff: DiffKind = !peer ? 'added' : peer.item.text !== entry.item.text ? 'changed' : 'same';
    rows.push({
      stableId,
      kind: entry.kind,
      title: entry.title,
      baseText: peer?.item.text ?? '',
      otherText: entry.item.text,
      diff,
      baseStatus: peer?.item.status ?? '—',
      otherStatus: entry.item.status,
      disputed: entry.item.disputed === true,
    });
    counts[diff] += 1;
  }
  for (const [stableId, entry] of left) {
    if (!right.has(stableId)) {
      rows.push({
        stableId,
        kind: entry.kind,
        title: entry.title,
        baseText: entry.item.text,
        otherText: '',
        diff: 'removed',
        baseStatus: entry.item.status,
        otherStatus: '—',
        disputed: entry.item.disputed === true,
      });
      counts.removed += 1;
    }
  }

  return { rows, counts, openDisputes: other.disputes.filter((dispute) => dispute.status === 'open').length };
}
