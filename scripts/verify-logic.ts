import { freshState, mergeDraftIntoVersion, migrateState, replayOutbox, resolveConflict, samplePlaywrightDraft, isLegacyArchive } from '../src/app/state/script.merge';
import { PlaywrightDraft, ScriptState, ScriptVersion } from '../src/app/state/script.model';
import { diffVersions } from '../src/app/state/script.compare';

let passed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) { console.error('FAIL:', name, extra ?? ''); process.exitCode = 1; }
  else { passed += 1; console.log('PASS:', name); }
}

// ---------- 1. 三路合并 ----------
const state0 = freshState();
const v12 = state0.versions.find((v) => v.id === 'v12')!;
const r1 = mergeDraftIntoVersion(v12, samplePlaywrightDraft(2));
const merged = r1.version;

check('编剧没动的行保留采纳结论', merged.lines.find((l) => l.id === 'l2')!.status === 'accepted');
check('编剧没动的行保留退回结论', merged.lines.find((l) => l.id === 'l1')!.status === 'returned');
check('退回行文本未被新稿盖掉', merged.lines.find((l) => l.id === 'l1')!.text === '你每次都说等明天，可舞台不会等我们。');
check('两边都动过挂待裁决 l1', merged.conflicts.some((c) => c.lineId === 'l1'), merged.conflicts);
check('两边都动过挂待裁决 l3', merged.conflicts.some((c) => c.lineId === 'l3'));
check('新增行进入版本且待确认', r1.added === 1 && merged.lines.some((l) => l.text === '灯亮着的时候，我从不敢看你的眼睛。' && l.status === 'pending'));
check('合并统计 applied/conflicted/skipped', r1.applied === 0 && r1.conflicted === 2 && r1.skipped === 1, r1);

// 再次合并同一份稿：已挂冲突不重复挂
const r1b = mergeDraftIntoVersion(merged, samplePlaywrightDraft(2));
check('同一冲突不重复挂起', r1b.version.conflicts.length === 2);

// 无结论行被编剧修改 → 自动并入，不挂冲突
const pendingVersion: ScriptVersion = {
  ...v12, conflicts: [],
  lines: [{ id: 'p1', role: '周野', text: '旧文本甲', baseText: '旧文本甲', status: 'pending', questions: [] }],
};
const draftAuto: PlaywrightDraft = { playwright: '林编剧', revisionSeq: 1, note: '', lines: [{ id: 'p1', role: '周野', text: '新文本乙', baseText: '旧文本甲' }] };
const r2 = mergeDraftIntoVersion(pendingVersion, draftAuto);
check('无结论行自动并入', r2.version.lines[0].text === '新文本乙' && r2.version.lines[0].baseText === '新文本乙' && r2.version.conflicts.length === 0);

// ---------- 2. 裁决 ----------
const keep = resolveConflict(merged, 'l1', 'keepCurrent');
check('保留排练稿：退回结论还在', keep.lines.find((l) => l.id === 'l1')!.status === 'returned');
check('保留排练稿：文本不变，冲突移除', keep.lines.find((l) => l.id === 'l1')!.text === '你每次都说等明天，可舞台不会等我们。' && !keep.conflicts.some((c) => c.lineId === 'l1'));
check('保留后基准对齐新稿，下轮不再挂', keep.lines.find((l) => l.id === 'l1')!.baseText === '别再说等明天——幕布拉开的那一刻，我们谁都躲不掉。');
const r2b = mergeDraftIntoVersion(keep, samplePlaywrightDraft(2));
check('保留裁决后同稿不再挂 l1', !r2b.version.conflicts.some((c) => c.lineId === 'l1'), r2b.version.conflicts);

const take = resolveConflict(merged, 'l3', 'takeIncoming');
const l3 = take.lines.find((l) => l.id === 'l3')!;
check('采用新稿：文本推进、重置待确认', l3.text === '看着这盏灯，告诉我，你到底为什么回来。' && l3.status === 'pending' && l3.baseText === l3.text);

// ---------- 3. 版本隔离：v12 的冲突不串到 v14 ----------
let state: ScriptState = { ...state0, versions: state0.versions.map((v) => (v.id === 'v12' ? merged : v)) };
check('v14 没有继承 v12 的待裁决', state.versions.find((v) => v.id === 'v14')!.conflicts.length === 0);

// ---------- 4. 离线疑问重放（顺序 + 最新版本比对 + 版本目标隔离） ----------
// 离线状态下，演员在 v12 的 l2（已采纳、文本 T2）记疑问 seq=2
state = { ...state, online: false, revisionSeq: 2 };
state = {
  ...state,
  outbox: [
    {
      id: 'q-old', actor: '苏青', note: '这句停顿能加长吗？', lineTextAtRecord: '那就让灯灭吧，我早已背熟黑暗。',
      revisionSeq: 2, recordedAt: 1000, targetVersionId: 'v12', targetLineId: 'l2', state: 'queued',
    },
    {
      // 晚到、序号更大：针对最新稿上仍未变的新增行（先模拟它已在版本里）
      id: 'q-new', actor: '苏青', note: '新收束句需要灯光配合', lineTextAtRecord: '灯亮着的时候，我从不敢看你的眼睛。',
      revisionSeq: 5, recordedAt: 5000, targetVersionId: 'v12', targetLineId: merged.lines.find((l) => l.text === '灯亮着的时候，我从不敢看你的眼睛。')!.id, state: 'queued',
    },
    {
      // 另一个版本的疑问：重放后必须落在 v14，不能落到 v12
      id: 'q-v14', actor: '老何', note: 'v14 专属疑问', lineTextAtRecord: '你总说明天，但今晚我们必须把话说完。',
      revisionSeq: 3, recordedAt: 3000, targetVersionId: 'v14', targetLineId: 'l1', state: 'queued',
    },
    {
      // 目标行已消失
      id: 'q-gone', actor: '老何', note: '行没了', lineTextAtRecord: 'X',
      revisionSeq: 4, recordedAt: 4000, targetVersionId: 'v12', targetLineId: 'nope', state: 'queued',
    },
  ],
};
// 重放前先把 l2 的文本改掉（模拟其间新稿落地）：旧疑问应变 stale
state = {
  ...state,
  versions: state.versions.map((v) => v.id === 'v12'
    ? { ...v, lines: v.lines.map((l) => (l.id === 'l2' ? { ...l, text: '那就让灯亮着吧，我已记住每一束光。' } : l)) }
    : v),
};

// 验证重放按 revisionSeq 排序（输入故意乱序）
const replay = replayOutbox(state);
check('重放统计 applied=2 stale=1 gone=1（晚到新稿+v14 各一条）', replay.applied === 2 && replay.stale === 1 && replay.gone === 1, { a: replay.applied, s: replay.stale, g: replay.gone });
const v12After = replay.state.versions.find((v) => v.id === 'v12')!;
const v14After = replay.state.versions.find((v) => v.id === 'v14')!;
const qOld = v12After.lines.find((l) => l.id === 'l2')!.questions.find((q) => q.id === 'q-old')!;
check('旧稿疑问重放后标 stale，不盖任何结论', qOld.stale === true && v12After.lines.find((l) => l.id === 'l2')!.status === 'accepted');
check('晚到疑问挂到最新稿行且未过期', v12After.lines.some((l) => l.questions.some((q) => q.id === 'q-new' && !q.stale)));
check('疑问按目标版本隔离：q-v14 落在 v14', v14After.lines.find((l) => l.id === 'l1')!.questions.some((q) => q.id === 'q-v14'));
check('v14 没收到 v12 的疑问', !v14After.lines.some((l) => l.questions.some((q) => q.id === 'q-old' || q.id === 'q-new')));
check('消失行标 gone 但记录保留', replay.state.outbox.find((q) => q.id === 'q-gone')!.state === 'gone');
check('重放幂等：再跑一次不重复挂', replayOutbox(replay.state).applied === 0);

// ---------- 5. 历史存档迁移 ----------
const legacy = {
  versions: [
    {
      id: 'old-v1', label: '联排存档 2026-09-01', playwright: '林编剧', note: '老格式',
      lines: [
        { role: '周岚', text: '甲', status: 'accepted' },
        { role: '周野', text: '乙', status: 'returned' },
        { role: '周岚', text: '丙' },
      ],
      cues: [{ id: 'c9', scene: '第一场', text: '钟声响三下', status: 'accepted' }],
    },
  ],
  activeVersionId: 'old-v1', rehearsalMode: true, online: true,
};
check('旧存档可识别', isLegacyArchive(legacy));
const migrated = migrateState(legacy);
check('迁移后 schema 升级', migrated.schemaVersion === 2);
const mv = migrated.versions[0];
check('旧记录一条不丢（文本/结论/提示）', mv.lines.map((l) => `${l.role}:${l.text}:${l.status}`).join('|') === '周岚:甲:accepted|周野:乙:returned|周岚:丙:pending' && mv.cues.length === 1);
check('无标记行补派稳定 id，同角色两次出场不撞', new Set(mv.lines.map((l) => l.id)).size === 3);
check('baseText 回填为当前文本', mv.lines.every((l) => l.baseText === l.text));
check('迁移版本带 legacy 标记', mv.legacy === true);
check('确定性：再次迁移同样输入 id 一致', migrateState(legacy).versions[0].lines.map((l) => l.id).join() === mv.lines.map((l) => l.id).join());

// 单版本裸存档也能迁移
const single = migrateState({ id: 'solo', label: '单版', lines: [{ role: '周岚', text: '丁' }] });
check('单个旧版本存档可迁移', single.versions.length === 1 && single.activeVersionId === 'solo');

// 迁移版本能对比、能“提词”（退回行被排除）
const diff = diffVersions(migrated.versions[0], migrated.versions[0]);
check('迁移版本可对比', diff.length === 3 && diff.every((d) => d.kind === 'same'));
const promptLines = mv.lines.filter((l) => l.status !== 'returned');
check('迁移版本可提词（退回行排除）', promptLines.length === 2);

// 已是新格式的存档不重复标记 legacy
const modern = migrateState(JSON.parse(JSON.stringify(state0)));
check('新格式存档原样保留', !modern.versions.some((v) => v.legacy) && modern.versions.length === 2);

console.log(`\n${passed} checks passed`);
