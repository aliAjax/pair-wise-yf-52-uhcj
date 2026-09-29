/**
 * 版本对比：按稳定行标记对齐；历史存档的派生日不一致时，退化为同角色按出场序配对。
 */
import { ScriptLine, ScriptVersion } from './script.model';

export type LineDiffKind = 'same' | 'changed' | 'added' | 'removed';

export interface LineDiff {
  kind: LineDiffKind;
  role: string;
  baseText?: string;
  currentText?: string;
  baseStatus?: ScriptLine['status'];
  currentStatus?: ScriptLine['status'];
}

export function diffVersions(base: ScriptVersion | undefined, current: ScriptVersion | undefined): LineDiff[] {
  if (!current) return [];
  if (!base) {
    return current.lines.map((line) => ({ kind: 'added', role: line.role, currentText: line.text, currentStatus: line.status }));
  }

  const baseById = new Map(base.lines.map((line) => [line.id, line]));
  const currentById = new Map(current.lines.map((line) => [line.id, line]));
  const usedBase = new Set<string>();
  const diffs: Array<LineDiff & { order: number }> = [];

  current.lines.forEach((line, order) => {
    const counterpart = baseById.get(line.id);
    if (counterpart) {
      usedBase.add(counterpart.id);
      diffs.push({
        order,
        kind: counterpart.text === line.text ? 'same' : 'changed',
        role: line.role,
        baseText: counterpart.text,
        currentText: line.text,
        baseStatus: counterpart.status,
        currentStatus: line.status,
      });
    } else {
      diffs.push({ order, kind: 'added', role: line.role, currentText: line.text, currentStatus: line.status });
    }
  });

  // 未配上的基准行：尝试与“当前版本里没 id 对应但同角色同出场序”的行配对（历史存档场景）。
  base.lines.forEach((line, baseOrder) => {
    if (usedBase.has(line.id)) return;
    const fallbackIndex = current.lines.findIndex(
      (candidate, currentOrder) =>
        !baseById.has(candidate.id) && candidate.role === line.role && ordinalOf(current, candidate) === ordinalOf(base, line) && currentOrder === baseOrder,
    );
    if (fallbackIndex >= 0) {
      const candidate = current.lines[fallbackIndex];
      const existing = diffs.find((diff) => diff.currentText === candidate.text && diff.kind === 'added');
      if (existing) {
        existing.kind = candidate.text === line.text ? 'same' : 'changed';
        existing.baseText = line.text;
        existing.baseStatus = line.status;
        usedBase.add(line.id);
        return;
      }
    }
    diffs.push({ order: base.lines.length + baseOrder, kind: 'removed', role: line.role, baseText: line.text, baseStatus: line.status });
  });

  return diffs
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...rest }) => rest);
}

function ordinalOf(version: ScriptVersion, target: ScriptLine): number {
  let seen = 0;
  for (const line of version.lines) {
    if (line.role === target.role) seen += 1;
    if (line === target) return seen;
  }
  return seen;
}
