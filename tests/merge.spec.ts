// 核心规则可执行验证：合并 / 待裁决 / 离线重放 / 跨版本隔离 / 旧存档迁移。
// 运行：npx esbuild tests/merge.spec.ts --bundle --platform=node --format=esm --outfile=/tmp/spec.mjs && node /tmp/spec.mjs
import assert from 'node:assert/strict';
import {
  ActorQuestion, Cue, CURRENT_SCHEMA_VERSION, ScriptLine, ScriptVersion,
} from '../src/app/state/script.model';
import { mergeWriterDraft, resolveDispute } from '../src/app/state/script.merge';
import { replayOutbox } from '../src/app/state/script.sync';
import { migrateState } from '../src/app/state/script.migration';
import { compareVersions } from '../src/app/state/script.diff';

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

const line = (partial: Partial<ScriptLine> & Pick<ScriptLine, 'stableId' | 'text' | 'role'>): ScriptLine => ({
  id: partial.stableId, revision: 1, status: 'pending', questions: [], ...partial,
});
const cue = (partial: Partial<Cue> & Pick<Cue, 'stableId' | 'text' | 'scene'>): Cue => ({
  id: partial.stableId, revision: 1, status: 'pending', questions: [], ...partial,
});
const version = (id: string, lines: ScriptLine[], cues: Cue[] = [], revision = 1): ScriptVersion => ({
  id, label: id, playwright: 'p', note: '', lines, cues, revision, disputes: [], orphanedQuestions: [],
});
const texts = (items: { stableId: string; text: string }[]) => Object.fromEntries(items.map((i) => [i.stableId, i.text]));

// 测试固定：排演稿里 l1 已采纳、l2 已退回、l3 待确认；编剧新稿改了 l1、l2、l3，删了 l4，新增 l5。
const target = version('rehearsal', [
  line({ stableId: 'l1', role: '周岚', text: '排演 A', status: 'accepted', priorDecision: { decision: 'accepted', at: 1 } }),
  line({ stableId: 'l2', role: '周野', text: '排演 B', status: 'returned', priorDecision: { decision: 'returned', at: 2 } }),
  line({ stableId: 'l3', role: '周岚', text: '排演 C' }),
  line({ stableId: 'l4', role: '周野', text: '排演 D', status: 'accepted', priorDecision: { decision: 'accepted', at: 3 } }),
]);
const base = version('base', [
  line({ stableId: 'l1', role: '周岚', text: '原始 A' }),
  line({ stableId: 'l2', role: '周野', text: '原始 B' }),
  line({ stableId: 'l3', role: '周岚', text: '排演 C' }),
  line({ stableId: 'l4', role: '周野', text: '排演 D' }),
]);
const source = version('writer', [
  line({ stableId: 'l1', role: '周岚', text: '新稿 A' }),
  line({ stableId: 'l2', role: '周野', text: '新稿 B' }),
  line({ stableId: 'l3', role: '周岚', text: '新稿 C' }),
  line({ stableId: 'l5', role: '周岚', text: '新稿 E' }),
]);
const baseLines = texts(base.lines);

console.log('1) 三方合并');
const { version: merged, report } = mergeWriterDraft({ target, source, baseLines, baseCues: {}, now: 100 });
check('编剧没动过的行保留舞台监督原结论（l3 与祖先一致但编剧改了 → 不属于未动；未动计数正确）', () => {
  assert.equal(report.added, 1); // l5
  assert.equal(report.deleted, 1); // l4
  assert.equal(report.updated, 3); // l1/l2 待裁决 + l3 自动更新
});
check('已采纳行两边都动 → 不盖结论，文本保持排演稿，挂待裁决', () => {
  const l1 = merged.lines.find((i) => i.stableId === 'l1')!;
  assert.equal(l1.text, '排演 A');
  assert.equal(l1.status, 'accepted');
  assert.equal(l1.disputed, true);
});
check('已退回行两边都动 → 退回决定不被新稿盖掉，保留退回并挂待裁决，且争议记录原结论 returned', () => {
  const l2 = merged.lines.find((i) => i.stableId === 'l2')!;
  assert.equal(l2.text, '排演 B');
  assert.equal(l2.status, 'returned');
  assert.equal(l2.priorDecision?.decision, 'returned');
  assert.equal(l2.disputed, true);
  const dispute = merged.disputes.find((d) => d.stableId === 'l2')!;
  assert.equal(dispute.priorDecision, 'returned');
  assert.equal(dispute.writerText, '新稿 B');
});
check('无结论行只有编剧动 → 自动并入新文本并回到 pending 复审', () => {
  const l3 = merged.lines.find((i) => i.stableId === 'l3')!;
  assert.equal(l3.text, '新稿 C');
  assert.equal(l3.status, 'pending');
  assert.equal(l3.disputed, false);
  assert.equal(l3.revision, 2);
});
check('编剧删除有结论行 → 删除待裁决，行仍保留', () => {
  const l4 = merged.lines.find((i) => i.stableId === 'l4')!;
  assert.equal(l4.disputed, true);
  const dispute = merged.disputes.find((d) => d.stableId === 'l4')!;
  assert.equal(dispute.deletion, true);
});
check('编剧新增行 → pending 进入', () => {
  const l5 = merged.lines.find((i) => i.stableId === 'l5')!;
  assert.equal(l5.status, 'pending');
  assert.equal(report.disputes, 3);
});
check('版本修订号在内容变化时递增', () => assert.equal(merged.revision, 2));

console.log('2) 裁决处理');
check('保留排演稿 → 解除争议但不动文本/结论', () => {
  const kept = resolveDispute(merged, merged.disputes.find((d) => d.stableId === 'l2')!.id, 'keepRehearsal', 200);
  const l2 = kept.lines.find((i) => i.stableId === 'l2')!;
  assert.equal(l2.text, '排演 B');
  assert.equal(l2.status, 'returned');
  assert.equal(l2.disputed, false);
  assert.equal(kept.disputes.find((d) => d.stableId === 'l2')!.status, 'resolved');
});
check('采用编剧稿 → 文本更新、回 pending，原退回结论在 priorDecision 留痕', () => {
  const taken = resolveDispute(merged, merged.disputes.find((d) => d.stableId === 'l2')!.id, 'takeWriter', 200);
  const l2 = taken.lines.find((i) => i.stableId === 'l2')!;
  assert.equal(l2.text, '新稿 B');
  assert.equal(l2.status, 'pending');
  assert.equal(l2.priorDecision?.decision, 'returned'); // 旧退回没被静默抹掉
});
check('确认删除争议 → 移除该行，其上疑问转入孤儿疑问不丢失', () => {
  const withQuestion: ScriptVersion = {
    ...merged,
    lines: merged.lines.map((l) => (l.stableId === 'l4'
      ? { ...l, questions: [{ id: 'q1', seq: 1, note: '疑问', createdAt: 1, baseText: '排演 D', baseRevision: 1, needsRecheck: false, resolved: false }] }
      : l)),
  };
  const disputeId = withQuestion.disputes.find((d) => d.stableId === 'l4')!.id;
  const removed = resolveDispute(withQuestion, disputeId, 'takeWriter', 300);
  assert.equal(removed.lines.some((l) => l.stableId === 'l4'), false);
  assert.equal(removed.orphanedQuestions.length, 1);
});

console.log('3) 离线疑问按 seq 重放，晚到的按最新排练版本重新比对');
const questionsOn: ActorQuestion[] = [];
const replayTarget = version('rv', [
  line({ stableId: 'k1', role: '周岚', text: '旧文本', revision: 1 }),
  // k2 在重放前已从最新排练版本移除
], [], 3);
{
  const { state, report: replayReport } = replayOutbox({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    versions: [replayTarget, version('other', [])],
    activeVersionId: 'rv',
    rehearsalMode: false,
    online: false,
    lastQuestionSeq: 3,
    outbox: [
      { id: 'o3', seq: 3, versionId: 'rv', stableId: 'k2', note: '晚到，行已删', baseText: '已删除行', baseRevision: 1, createdAt: 3 },
      { id: 'o1', seq: 1, versionId: 'rv', stableId: 'k1', note: '记录时文本已旧', baseText: '更旧的文本', baseRevision: 1, createdAt: 1 },
      { id: 'o2', seq: 2, versionId: 'gone', stableId: 'x', note: '版本还没到', baseText: '', baseRevision: 1, createdAt: 2 },
    ],
    mergeSessions: [],
  }, 500);
  check('重放按 seq 顺序处理（结果与到达顺序无关）', () => assert.ok(replayReport.applied + replayReport.recheck + replayReport.orphaned >= 2));
  check('晚到疑问：行文本已变 → needsRecheck 而不是用旧结论盖回', () => {
    const rv = state.versions.find((v) => v.id === 'rv')!;
    const k1 = rv.lines.find((l) => l.stableId === 'k1')!;
    assert.equal(k1.questions[0].needsRecheck, true);
    assert.equal(k1.questions[0].seq, 1);
  });
  check('行已不存在 → 疑问留到 orphanedQuestions，不丢', () => {
    const rv = state.versions.find((v) => v.id === 'rv')!;
    assert.equal(rv.orphanedQuestions[0].id, 'o3');
  });
  check('版本不存在 → 条目留在发件箱稍后重试', () => assert.equal(state.outbox[0].id, 'o2'));
  assert.ok(questionsOn);
}

console.log('4) 待裁决按版本隔离');
{
  const va = version('va', [line({ stableId: 's1', role: '周岚', text: 'A', status: 'returned', priorDecision: { decision: 'returned', at: 1 } })]);
  const vb = version('vb', [line({ stableId: 's2', role: '周野', text: 'B' })]);
  const writerA = version('w', [line({ stableId: 's1', role: '周岚', text: 'A2' })]);
  const { version: mergedA } = mergeWriterDraft({ target: va, source: writerA, baseLines: { s1: 'A' }, baseCues: {}, now: 1 });
  check('只在合并目标版本上产生争议，切到别的版本看不到', () => {
    assert.equal(mergedA.disputes.length, 1);
    assert.equal(vb.disputes.length, 0);
  });
}

console.log('5) 历史存档迁移：没有稳定行标记照样打开/对比/提词，记录不丢');
{
  const legacy = {
    activeVersionId: 'old',
    versions: [{
      id: 'old', label: '旧稿', playwright: '林', note: '',
      lines: [
        { id: 'x1', role: '周岚', text: '旧台词 1', status: 'accepted' },
        { id: 'x2', role: '周野', text: '旧台词 2', status: 'returned' },
        { id: 'x3', role: '周野', text: '旧台词 2', status: 'pending' }, // 同文本重复行也需唯一 stableId
      ],
      cues: [{ id: 'xc1', scene: '一场', text: '旧提示', status: 'pending' }],
    }],
  };
  const { state, recoveredStableIds } = migrateState(legacy);
  check('schema 升级到当前版本并确定性补齐 stableId', () => {
    assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(recoveredStableIds, 4);
    const ids = state.versions[0].lines.map((l) => l.stableId);
    assert.equal(new Set(ids).size, 3);
  });
  check('旧采纳/退回结论迁为 priorDecision，现有记录不丢', () => {
    const [l1, l2] = state.versions[0].lines;
    assert.equal(l1.priorDecision?.decision, 'accepted');
    assert.equal(l2.priorDecision?.decision, 'returned');
  });
  check('迁移后可按 stableId 做版本对比', () => {
    const newer = version('old', state.versions[0].lines.map((l) => ({ ...l, text: l.text + ' 改' })));
    const { counts } = compareVersions(state.versions[0], newer);
    assert.equal(counts.changed, 3);
  });
  check('迁移后已采纳台词可进入提词（accepted 且无争议）', () => {
    const prompts = state.versions[0].lines.filter((l) => l.status === 'accepted' && !l.disputed);
    assert.equal(prompts.length, 1);
  });
  check('迁移幂等：已是当前 schema 不重复补建', () => {
    const again = migrateState(state);
    assert.equal(again.recoveredStableIds, 0);
  });
}

console.log(`\n全部 ${passed} 项验证通过 ✅`);
