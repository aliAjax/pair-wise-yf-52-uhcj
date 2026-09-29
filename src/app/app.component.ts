import { CdkDragDrop, DragDropModule } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Observable, Subscription } from 'rxjs';
import {
  activateVersion,
  addVersion,
  editLine,
  importLegacySnapshot,
  mergeWriterDraft,
  recordQuestion,
  removeLine,
  reorderLines,
  reviewCue,
  reviewLine,
  resolveDispute,
  resolveQuestion,
  setOnline,
  toggleRehearsal,
} from './state/script.actions';
import { compareVersions, DiffRow } from './state/script.diff';
import {
  Cue,
  Dispute,
  ReviewItem,
  ScriptLine,
  ScriptState,
  ScriptVersion,
} from './state/script.reducer';
import { deriveStableId } from './state/script.model';

// 供「导入历史存档」演示：旧快照没有 schemaVersion / stableId / revision 等字段。
const LEGACY_SNAPSHOT = JSON.stringify({
  activeVersionId: 'v1',
  rehearsalMode: false,
  online: true,
  versions: [
    {
      id: 'archive-v1',
      label: '历史存档 · 首演联排版',
      playwright: '林编剧',
      note: '升级前导出的存档，行没有稳定标记。',
      lines: [
        { id: 'a1', role: '周岚', text: '大幕拉开的时候，别回头看我。', status: 'accepted' },
        { id: 'a2', role: '周野', text: '可我只记得那束追光落在你肩上。', status: 'returned' },
        {
          id: 'a3', role: '周岚', text: '（旧批注）这句我总抢拍，需要再对一次光位。', status: 'pending',
          questions: [{ id: 'q-old-1', seq: 1, note: '旧存档里的疑问：此处灯光是否提前？', createdAt: 0, baseText: '（旧批注）这句我总抢拍，需要再对一次光位。', baseRevision: 0, resolved: false }],
        },
      ],
      cues: [
        { id: 'ac1', scene: '第一场', text: '开场钟声三响后缓升面光', status: 'accepted' },
      ],
    },
  ],
});

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DragDropModule, TranslocoModule,
    MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule,
    MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule,
  ],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button class="net-btn" (click)="toggleOnline()">
        {{ (online$ | async) ? '在线' : '离线缓存中' }}
        @if ((outbox$ | async)?.length) {
          <span class="outbox-pill">{{ (outbox$ | async)?.length }} 条疑问待重放</span>
        }
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        {{ (rehearsal$ | async) ? '退出提词' : '排练提词模式' }}
      </button>
    </mat-toolbar>

    <main [class.rehearsal]="rehearsal$ | async">
      <!-- ================= 提词模式 ================= -->
      @if (rehearsal$ | async) {
        <section class="prompter">
          <mat-card>
            <mat-card-title>大字号提词 · {{ activeVersion()?.label }}</mat-card-title>
            <mat-card-subtitle>仅采纳状态台词进入提词；退回台词与待裁决行一律排除。</mat-card-subtitle>
            @if (openDisputes(activeVersion()).length) {
              <p class="blocked-note">⚠ 本版本有 {{ openDisputes(activeVersion()).length }} 条待裁决未处理，相关行暂不可提词。</p>
            }
            @for (line of promptLines(activeVersion()); track line.stableId) {
              <p class="prompt-line"><b>{{ line.role }}</b>：{{ line.text }}</p>
            }
            @for (cue of promptCues(activeVersion()); track cue.stableId) {
              <p class="prompt-cue">【{{ cue.scene }}】{{ cue.text }}</p>
            }
            @if (!promptLines(activeVersion()).length) {
              <p class="blocked-note">暂无可提词的已采纳台词。</p>
            }
          </mat-card>
        </section>
      } @else {
      <!-- ================= 常规工作模式 ================= -->
      <section class="summary">
        <mat-card>
          <mat-card-title>版本控制（待裁决按版本各自隔离）</mat-card-title>
          <p>编剧提交后由舞台监督逐条采纳；编剧没动的行保留原结论，两边都动的行挂待裁决，不会盖掉退回决定。</p>
          <div class="chips">
            @for (version of (state$ | async)?.versions; track version.id) {
              <button mat-stroked-button
                [class.active-chip]="version.id === (state$ | async)?.activeVersionId"
                (click)="activate(version.id)">
                {{ version.label }} · {{ version.playwright }}
                @if (openDisputes(version).length) {
                  <span class="dispute-badge">{{ openDisputes(version).length }} 待裁决</span>
                }
              </button>
            }
            <button mat-flat-button color="primary" (click)="createDraft()">新增本地修订</button>
          </div>
        </mat-card>
      </section>

      @if (activeVersion(); as activeVersion) {
      <section class="merge-bar">
        <mat-card>
          <mat-card-title>并入编剧新稿（三方合并）</mat-card-title>
          <div class="merge-controls">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>排练版本（合并目标）</mat-label>
              <mat-select [value]="activeVersion.id" disabled><mat-option [value]="activeVersion.id">{{ activeVersion.label }}</mat-option></mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>编剧新稿</mat-label>
              <mat-select [(ngModel)]="mergeSourceId">
                @for (version of mergeCandidates(activeVersion); track version.id) {
                  <mat-option [value]="version.id">{{ version.label }} · {{ version.playwright }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>共同祖先（base）</mat-label>
              <mat-select [(ngModel)]="mergeBaseId">
                @for (version of (state$ | async)?.versions; track version.id) {
                  <mat-option [value]="version.id">{{ version.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <button mat-flat-button color="primary"
              [disabled]="!mergeSourceId || activeVersion.id === mergeSourceId"
              (click)="runMerge()">并入新稿</button>
          </div>
          @if (activeSession(activeVersion.id); as session) {
            <p class="merge-report">
              合并会话进行中 · 基准 {{ versionLabel(session.baseVersionId) }}
              → 未变 {{ session.summary.unchanged }}，更新 {{ session.summary.updated }}，
              新增 {{ session.summary.added }}，删除 {{ session.summary.deleted }}，
              待裁决 {{ session.summary.disputes }}。切到别的版本，待裁决仍留在本版本。
            </p>
          }
        </mat-card>
      </section>

      <section class="workspace">
        <mat-card class="script">
          <mat-card-title>{{ activeVersion.label }} <span class="rev">rev.{{ activeVersion.revision }}</span></mat-card-title>
          <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>

          <!-- 待裁决 -->
          @if (openDisputes(activeVersion).length) {
            <div class="disputes">
              <h4>待裁决（{{ openDisputes(activeVersion).length }}）——编剧新稿与舞台监督结论冲突</h4>
              @for (dispute of openDisputes(activeVersion); track dispute.id) {
                <div class="dispute">
                  <div class="dispute-text">
                    <span class="tag">{{ dispute.kindLabel }} · {{ dispute.kind === 'line' ? dispute.role : dispute.scene }}</span>
                    <p class="old">排演稿（原结论：{{ dispute.priorDecision === 'returned' ? '退回' : '采纳' }}）：
                      {{ dispute.deletion ? '（该行已被编剧从新稿删除）' : dispute.rehearsalText }}</p>
                    @if (!dispute.deletion) {
                      <p class="new">编剧新稿：{{ dispute.writerText }}</p>
                    }
                  </div>
                  <div class="dispute-actions">
                    <button mat-stroked-button color="primary" (click)="resolve(activeVersion.id, dispute.id, 'keepRehearsal')">
                      {{ dispute.deletion ? '驳回删除，保留原行' : '保留排演稿' }}
                    </button>
                    <button mat-stroked-button color="warn" (click)="resolve(activeVersion.id, dispute.id, 'takeWriter')">
                      {{ dispute.deletion ? '确认删除（仍留痕）' : '采用编剧稿，交复审' }}
                    </button>
                  </div>
                </div>
              }
            </div>
          }

          <mat-tab-group>
            <mat-tab [label]="'角色台词（' + activeVersion.lines.length + '）'">
              <div cdkDropList (cdkDropListDropped)="dropLine($event)">
                @for (line of activeVersion.lines; track line.stableId) {
                  <article class="line" cdkDrag [class.returned]="line.status === 'returned'" [class.disputed]="line.disputed">
                    <div class="line-body">
                      <b>{{ line.role }}</b>
                      @if (editingId === line.id) {
                        <div class="inline-edit">
                          <mat-form-field appearance="outline" subscriptSizing="dynamic">
                            <input matInput [(ngModel)]="editingText" (keyup.enter)="saveEdit(line.id)" />
                          </mat-form-field>
                          <button mat-button color="primary" (click)="saveEdit(line.id)">保存</button>
                          <button mat-button (click)="editingId = null">取消</button>
                        </div>
                      } @else {
                        <p>{{ line.text }}</p>
                      }
                      <div class="meta">
                        <span class="status" [class.ok]="line.status === 'accepted'" [class.bad]="line.status === 'returned'">{{ statusText(line.status) }}</span>
                        @if (line.priorDecision) {
                          <span class="prior">舞台监督{{ line.priorDecision.decision === 'returned' ? '退回' : '采纳' }}留痕</span>
                        }
                        @if (line.disputed) { <span class="dispute-tag">待裁决</span> }
                        <span class="rev-tag">rev.{{ line.revision }}</span>
                      </div>
                      @if (line.questions.length) {
                        <ul class="questions">
                          @for (question of line.questions; track question.id) {
                            <li [class.resolved]="question.resolved" [class.recheck]="question.needsRecheck">
                              <span class="qseq">#{{ question.seq }}</span>{{ question.note }}
                              @if (question.needsRecheck) { <span class="recheck-tag">晚到 · 需按最新稿重新比对</span> }
                              @if (question.resolved) { <span class="resolved-tag">已处理</span> }
                              @if (!question.resolved) {
                                <button mat-button color="primary" (click)="settleQuestion(activeVersion.id, question.id)">处理</button>
                              }
                            </li>
                          }
                        </ul>
                      }
                    </div>
                    <div class="line-actions">
                      <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                      <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                      <button mat-icon-button (click)="startEdit(line)"><mat-icon>edit</mat-icon></button>
                      <button mat-icon-button color="warn" (click)="removeLine(line.id)"><mat-icon>delete_outline</mat-icon></button>
                    </div>
                  </article>
                  <div class="ask-row">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic" class="ask-input">
                      <input matInput placeholder="演员记疑问（离线自动入发件箱）" [(ngModel)]="questionDrafts[line.stableId]"
                        (keyup.enter)="ask(activeVersion, line)" />
                    </mat-form-field>
                    <button mat-stroked-button (click)="ask(activeVersion, line)">记疑问</button>
                  </div>
                }
              </div>
            </mat-tab>

            <mat-tab [label]="'舞台提示（' + activeVersion.cues.length + '）'">
              @for (cue of activeVersion.cues; track cue.stableId) {
                <article class="line" [class.returned]="cue.status === 'returned'" [class.disputed]="cue.disputed">
                  <div class="line-body">
                    <b>【{{ cue.scene }}】</b>
                    <p>{{ cue.text }}</p>
                    <div class="meta">
                      <span class="status" [class.ok]="cue.status === 'accepted'" [class.bad]="cue.status === 'returned'">{{ statusText(cue.status) }}</span>
                      @if (cue.priorDecision) {
                        <span class="prior">舞台监督{{ cue.priorDecision.decision === 'returned' ? '退回' : '采纳' }}留痕</span>
                      }
                      @if (cue.disputed) { <span class="dispute-tag">待裁决</span> }
                    </div>
                    @if (cue.questions.length) {
                      <ul class="questions">
                        @for (question of cue.questions; track question.id) {
                          <li [class.resolved]="question.resolved" [class.recheck]="question.needsRecheck">
                            <span class="qseq">#{{ question.seq }}</span>{{ question.note }}
                            @if (question.needsRecheck) { <span class="recheck-tag">晚到 · 需按最新稿重新比对</span> }
                            @if (question.resolved) { <span class="resolved-tag">已处理</span> }
                            @if (!question.resolved) {
                              <button mat-button color="primary" (click)="settleQuestion(activeVersion.id, question.id)">处理</button>
                            }
                          </li>
                        }
                      </ul>
                    }
                  </div>
                  <div class="line-actions">
                    <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                    <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                  </div>
                </article>
                <div class="ask-row">
                  <mat-form-field appearance="outline" subscriptSizing="dynamic" class="ask-input">
                    <input matInput placeholder="演员记疑问（离线自动入发件箱）" [(ngModel)]="questionDrafts[cue.stableId]"
                      (keyup.enter)="ask(activeVersion, cue)" />
                  </mat-form-field>
                  <button mat-stroked-button (click)="ask(activeVersion, cue)">记疑问</button>
                </div>
              }
            </mat-tab>
          </mat-tab-group>
        </mat-card>

        <aside class="side">
          <mat-card class="compare">
            <mat-card-title>版本对比（按稳定行标记对齐）</mat-card-title>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="full">
              <mat-label>对比基准</mat-label>
              <mat-select [(ngModel)]="compareBaseId">
                @for (version of (state$ | async)?.versions; track version.id) {
                  <mat-option [value]="version.id">{{ version.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            @if (diffRows(activeVersion); as diff) {
              <div class="diff-summary">
                <span><b>新增</b> {{ diff.counts.added }}</span>
                <span><b>改动</b> {{ diff.counts.changed }}</span>
                <span><b>删除</b> {{ diff.counts.removed }}</span>
                <span><b>未变</b> {{ diff.counts.same }}</span>
                <span class="warn"><b>待裁决</b> {{ diff.openDisputes }}</span>
              </div>
              @for (row of diff.rows; track row.stableId + row.diff) {
                <div class="diff-row" [class]="'d-' + row.diff">
                  <span class="diff-kind">{{ diffLabel(row.diff) }}{{ row.kind === 'line' ? ' · ' + row.title : ' · ' + row.title }}</span>
                  @if (row.baseText) { <p class="old">{{ row.baseText }} <i>({{ statusText(row.baseStatus) }})</i></p> }
                  @if (row.otherText) { <p class="new">{{ row.otherText }} <i>({{ statusText(row.otherStatus) }})</i></p> }
                  @if (row.disputed) { <span class="dispute-tag">待裁决</span> }
                </div>
              }
            }
          </mat-card>

          <mat-card class="archive">
            <mat-card-title>历史存档</mat-card-title>
            <p>旧存档没有稳定行标记，导入后自动补齐，照样打开、对比和进入提词，记录不丢。</p>
            <button mat-stroked-button (click)="importLegacy()">导入旧版存档（演示）</button>
            @if ((state$ | async)?.lastMigration; as migration) {
              <p class="migration">已从 schema v{{ migration.from }} 升级到 v{{ migration.to }}，补建 {{ migration.recoveredStableIds }} 个稳定行标记。</p>
            }
          </mat-card>
        </aside>
      </section>
      }
      }
    </main>

    @if (!(online$ | async)) {
      <aside class="offline">
        <b>网络不可用</b>
        <p>修改已写入本地缓存；演员疑问进入发件箱，恢复网络后按修订顺序重放，晚到的按最新排练版本重新比对。</p>
        @if (outbox$ | async; as outbox) {
          <p class="queue">发件箱（{{ outbox.length }}）：</p>
          <ul>
            @for (entry of outbox; track entry.id) {
              <li>#{{ entry.seq }} → {{ versionLabel(entry.versionId) }}：{{ entry.note }} <i>记录于 rev.{{ entry.baseRevision }}</i></li>
            }
          </ul>
        }
        <button mat-flat-button color="accent" (click)="goOnline()">模拟恢复网络并重放</button>
      </aside>
    } @else if ((state$ | async)?.lastReplay; as replay) {
      <p class="replay-toast">上次重放：直接生效 {{ replay.applied }}，需重新比对 {{ replay.recheck }}，找不到行 {{ replay.orphaned }}（已留档）。</p>
    }
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; gap: 10px; }
    .spacer { flex: 1; }
    .net-btn { display: inline-flex; align-items: center; gap: 8px; }
    .outbox-pill { background: #b45309; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
    main { max-width: 1240px; margin: 24px auto; padding: 0 18px 80px; }
    main.rehearsal { max-width: 960px; background: #111827; color: #f9fafb; margin-top: 0; min-height: 100vh; }
    .summary, .merge-bar { margin-bottom: 16px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .active-chip { background: rgba(25, 118, 210, .12); }
    .dispute-badge { margin-left: 8px; color: #b45309; font-weight: 600; }
    .merge-controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .merge-controls mat-form-field { min-width: 220px; }
    .merge-report { margin: 10px 0 0; color: #374151; font-size: 13px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 18px; align-items: start; }
    .side { display: flex; flex-direction: column; gap: 18px; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 14px 4px; border-bottom: 1px solid #e5e7eb; }
    .line.returned { background: #fef2f2; }
    .line.disputed { outline: 2px solid #f59e0b; outline-offset: -2px; background: #fffbeb; }
    .line-body { flex: 1; }
    .line-body p { margin: 6px 0; font-size: 16px; line-height: 1.6; }
    .line-actions { display: flex; flex-shrink: 0; }
    .meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .status.bad { color: #b91c1c; }
    .prior, .rev-tag { font-size: 11px; color: #6b7280; background: #f3f4f6; border-radius: 6px; padding: 1px 7px; }
    .dispute-tag, .recheck-tag { font-size: 11px; color: #92400e; background: #fef3c7; border-radius: 6px; padding: 1px 7px; }
    .resolved-tag { font-size: 11px; color: #166534; background: #dcfce7; border-radius: 6px; padding: 1px 7px; }
    .inline-edit { display: flex; align-items: center; gap: 8px; }
    .inline-edit mat-form-field { min-width: 320px; }
    .questions { margin: 6px 0 0; padding-left: 18px; }
    .questions li { font-size: 13px; color: #374151; }
    .questions li.resolved { color: #9ca3af; text-decoration: line-through; }
    .questions li.recheck { color: #92400e; }
    .qseq { color: #2563eb; margin-right: 6px; font-weight: 600; }
    .ask-row { display: flex; gap: 8px; align-items: center; padding: 6px 0 10px; border-bottom: 1px dashed #e5e7eb; }
    .ask-input { flex: 1; }
    .disputes { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
    .disputes h4 { margin: 0 0 8px; color: #92400e; }
    .dispute { display: flex; justify-content: space-between; gap: 14px; padding: 10px 0; border-top: 1px solid #fde68a; }
    .dispute-text p { margin: 4px 0; font-size: 14px; }
    .dispute-text .old { color: #b91c1c; }
    .dispute-text .new { color: #15803d; }
    .tag { font-size: 12px; background: #fde68a; border-radius: 6px; padding: 1px 8px; }
    .dispute-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
    .full { width: 100%; }
    .diff-summary { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; margin: 8px 0; }
    .diff-summary .warn { color: #b45309; }
    .diff-row { padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    .diff-row .old { color: #b91c1c; margin: 2px 0; text-decoration: line-through; }
    .diff-row .new { color: #15803d; margin: 2px 0; }
    .diff-kind { font-weight: 600; color: #374151; }
    .d-added .diff-kind { color: #15803d; }
    .d-removed .diff-kind { color: #b91c1c; }
    .d-changed .diff-kind { color: #b45309; }
    .rev { font-size: 12px; color: #6b7280; font-weight: 400; }
    .archive p, .migration { font-size: 12px; color: #6b7280; }
    .migration { color: #15803d; }
    .prompter .prompt-line { font-size: 34px; line-height: 1.7; margin: 22px 0; }
    .prompter .prompt-cue { font-size: 22px; color: #fbbf24; line-height: 1.6; }
    .prompter .blocked-note { color: #fca5a5; font-size: 16px; }
    .offline { position: fixed; right: 18px; bottom: 18px; max-width: 360px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; z-index: 10; }
    .offline ul { margin: 6px 0; padding-left: 18px; font-size: 12px; max-height: 160px; overflow: auto; }
    .offline p { font-size: 12px; margin: 6px 0; }
    .replay-toast { position: fixed; right: 18px; bottom: 18px; margin: 0; padding: 12px 16px; background: #15803d; color: #fff; border-radius: 10px; font-size: 13px; z-index: 10; }
    @media (max-width: 900px) { .workspace { grid-template-columns: 1fr; } .dispute { flex-direction: column; } }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$: Observable<ScriptState> = this.store.select('script');
  readonly online$ = this.store.select((state) => state.script.online);
  readonly rehearsal$ = this.store.select((state) => state.script.rehearsalMode);
  readonly outbox$ = this.store.select((state) => state.script.outbox);

  mergeSourceId: string | null = null;
  mergeBaseId = '';
  compareBaseId = '';
  editingId: string | null = null;
  editingText = '';
  questionDrafts: Record<string, string> = {};

  private subscription?: Subscription;
  private snapshot!: ScriptState;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) => {
      this.snapshot = state;
      localStorage.setItem('yf52-script-state', JSON.stringify(state));
      // 首次进入时默认选择合并源与对比基准。
      if (!this.mergeSourceId) {
        this.mergeSourceId = state.versions.find((version) => version.id !== state.activeVersionId)?.id ?? null;
      }
      if (!this.mergeBaseId || !state.versions.some((version) => version.id === this.mergeBaseId)) {
        this.mergeBaseId = state.activeVersionId;
      }
      if (!this.compareBaseId || !state.versions.some((version) => version.id === this.compareBaseId)) {
        this.compareBaseId = state.versions.find((version) => version.id !== state.activeVersionId)?.id
          ?? state.activeVersionId;
      }
    });
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activeVersion(): ScriptVersion | undefined {
    return this.snapshot.versions.find((version) => version.id === this.snapshot.activeVersionId)
      ?? this.snapshot.versions[0];
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  goOnline() { this.store.dispatch(setOnline({ online: true })); }
  toggleOnline() { this.store.dispatch(setOnline({ online: !this.snapshot.online })); }

  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }
  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex !== event.currentIndex) {
      this.store.dispatch(reorderLines({ from: event.previousIndex, to: event.currentIndex }));
    }
  }

  startEdit(line: ScriptLine) { this.editingId = line.id; this.editingText = line.text; }
  saveEdit(id: string) {
    if (this.editingText.trim()) this.store.dispatch(editLine({ id, text: this.editingText.trim() }));
    this.editingId = null;
  }
  removeLine(id: string) { this.store.dispatch(removeLine({ id })); }

  ask(version: ScriptVersion, item: ReviewItem) {
    const note = (this.questionDrafts[item.stableId] ?? '').trim();
    if (!note) return;
    this.store.dispatch(recordQuestion({ versionId: version.id, stableId: item.stableId, note }));
    this.questionDrafts[item.stableId] = '';
  }

  settleQuestion(versionId: string, questionId: string) {
    this.store.dispatch(resolveQuestion({ versionId, questionId }));
  }

  mergeCandidates(target: ScriptVersion): ScriptVersion[] {
    return this.snapshot.versions.filter((version) => version.id !== target.id);
  }

  runMerge() {
    const source = this.snapshot.versions.find((version) => version.id === this.mergeSourceId);
    if (!source) return;
    this.store.dispatch(mergeWriterDraft({
      targetVersionId: this.snapshot.activeVersionId,
      source,
      baseVersionId: this.mergeBaseId || this.snapshot.activeVersionId,
    }));
  }

  resolve(versionId: string, disputeId: string, outcome: 'keepRehearsal' | 'takeWriter') {
    this.store.dispatch(resolveDispute({ versionId, disputeId, outcome }));
  }

  openDisputes(version?: ScriptVersion): Dispute[] {
    return version?.disputes.filter((dispute) => dispute.status === 'open') ?? [];
  }

  activeSession(versionId: string) {
    return this.snapshot.mergeSessions.find(
      (session) => session.targetVersionId === versionId && !session.finishedAt,
    );
  }

  versionLabel(id: string): string {
    return this.snapshot.versions.find((version) => version.id === id)?.label ?? id;
  }

  diffRows(active: ScriptVersion): ReturnType<typeof compareVersions> | null {
    const base = this.snapshot.versions.find((version) => version.id === this.compareBaseId);
    return base ? compareVersions(base, active) : null;
  }

  promptLines(version?: ScriptVersion): ScriptLine[] {
    return (version?.lines ?? []).filter((line) => line.status === 'accepted' && !line.disputed);
  }
  promptCues(version?: ScriptVersion): Cue[] {
    return (version?.cues ?? []).filter((cue) => cue.status === 'accepted' && !cue.disputed);
  }

  statusText(status: string): string {
    return status === 'accepted' ? '已采纳' : status === 'returned' ? '已退回' : '待确认';
  }
  diffLabel(diff: DiffRow['diff']): string {
    return diff === 'added' ? '新增' : diff === 'removed' ? '删除' : diff === 'changed' ? '改动' : '未变';
  }

  importLegacy() {
    this.store.dispatch(importLegacySnapshot({ raw: LEGACY_SNAPSHOT }));
  }

  createDraft() {
    const stamp = Date.now().toString().slice(-5);
    const id = `local-${stamp}`;
    const makeLine = (role: string, text: string): ScriptLine => ({
      id: `${id}-l1`,
      stableId: deriveStableId('line', text, role),
      role,
      text,
      status: 'pending',
      revision: 1,
      questions: [],
    });
    const makeCue = (scene: string, text: string): Cue => ({
      id: `${id}-c1`,
      stableId: deriveStableId('cue', text, scene),
      scene,
      text,
      status: 'pending',
      revision: 1,
      questions: [],
    });
    const version: ScriptVersion = {
      id,
      label: `本地修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，可选择编剧新稿并入后再逐条裁决。',
      revision: 1,
      lines: [makeLine('周岚', '这次换你告诉我，灯亮之后准备去哪里。')],
      cues: [makeCue('第三场', '追光保持到台词结束，再执行全场收光')],
      disputes: [],
      orphanedQuestions: [],
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
    this.mergeBaseId = this.snapshot.activeVersionId;
  }
}
