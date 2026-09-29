import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription, take } from 'rxjs';
import {
  activateVersion,
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
} from './state/script.actions';
import { diffVersions, LineDiff } from './state/script.compare';
import { isLegacyArchive, parseDraftFile, persistState, replayOutbox, samplePlaywrightDraft } from './state/script.merge';
import { ScriptState, ScriptVersion } from './state/script.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, FormsModule, TranslocoModule,
    MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatBadgeModule, MatSnackBarModule, MatTooltipModule,
  ],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()" class="online-btn">
        <mat-icon>{{ online ? 'cloud_done' : 'cloud_off' }}</mat-icon>
        {{ online ? '在线' : '离线缓存中' }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        <mat-icon>{{ rehearsalMode ? 'edit_note' : 'present_to_all' }}</mat-icon>
        {{ rehearsalMode ? '返回工作台' : '进入提词' }}
      </button>
    </mat-toolbar>

    <!-- ===================== 提词模式：大字号，历史存档版本同样可进入 ===================== -->
    <section class="teleprompter" *ngIf="rehearsalMode && activeVersion">
      <header class="tp-head">
        <div>
          <h2>{{ activeVersion.label }}<span class="legacy-tag" *ngIf="activeVersion.legacy">历史存档</span></h2>
          <p>{{ activeVersion.note }}</p>
        </div>
        <button mat-stroked-button (click)="toggleRehearsal()">退出提词</button>
      </header>
      <ol class="tp-lines">
        <li *ngFor="let line of teleprompterLines(activeVersion)" [class.pending]="line.status === 'pending'">
          <span class="tp-role">{{ line.role }}</span>
          <span class="tp-text">{{ line.text }}</span>
        </li>
      </ol>
      <p class="tp-returned" *ngIf="returnedLines(activeVersion).length">
        已退回、不进排练：<span *ngFor="let line of returnedLines(activeVersion)">「{{ line.text }}」 </span>
      </p>
    </section>

    <main *ngIf="!rehearsalMode">
      <!-- ===================== 版本切换：冲突计数挂在各自版本上 ===================== -->
      <section class="summary">
        <mat-card>
          <mat-card-title>版本控制</mat-card-title>
          <p>编剧修订在当前排练版本上做三路合并：编剧没动的行保留舞台监督结论，两边都动过的行挂待裁决，绝不盖掉退回决定。</p>
          <div class="chips">
            <button mat-stroked-button *ngFor="let version of state.versions"
                    [class.active-chip]="version.id === state.activeVersionId"
                    [matTooltip]="version.note"
                    (click)="activate(version.id)">
              {{ version.label }} · {{ version.playwright }}
              <span class="conflict-badge" *ngIf="version.conflicts.length" [matBadge]="version.conflicts.length" matBadgeColor="warn" matBadgeSize="small">待裁决</span>
            </button>
          </div>
          <div class="actions">
            <button mat-flat-button color="primary" (click)="mergeSampleDraft()">
              <mat-icon>merge</mat-icon>并入编剧修订稿 #{{ state.revisionSeq }}
            </button>
            <button mat-stroked-button (click)="draftPicker.click()">
              <mat-icon>upload_file</mat-icon>导入编剧稿 JSON
            </button>
            <button mat-stroked-button (click)="archivePicker.click()">
              <mat-icon>history_toggle_off</mat-icon>导入历史存档
            </button>
            <input #draftPicker type="file" accept=".json,application/json" hidden (change)="onDraftFile($event)">
            <input #archivePicker type="file" accept=".json,application/json" hidden (change)="onArchiveFile($event)">
          </div>
          <p class="merge-summary" *ngIf="activeVersion?.lastMerge as summary">
            上次合并（{{ summary.playwright }} · 修订#{{ summary.revisionSeq }}）：
            自动并入 {{ summary.applied }} 条，待裁决 {{ summary.conflicted }} 条，新增 {{ summary.added }} 条，未改动保留 {{ summary.skipped }} 条。
          </p>
        </mat-card>
      </section>

      <section class="workspace" *ngIf="activeVersion">
        <mat-card class="script">
          <mat-card-title>
            {{ activeVersion.label }}
            <span class="legacy-tag" *ngIf="activeVersion.legacy">由历史存档迁移 · 行标记已补派</span>
          </mat-card-title>
          <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>

          <mat-tab-group>
            <!-- 角色台词 -->
            <mat-tab [label]="'角色台词 (' + activeVersion.lines.length + ')'">
              <div class="actor-row">
                当前演员：
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <input matInput [(ngModel)]="actorName" placeholder="演员姓名">
                </mat-form-field>
              </div>
              <article class="line" *ngFor="let line of activeVersion.lines">
                <div class="line-body">
                  <b>{{ line.role }}</b>
                  <p>{{ line.text }}</p>
                  <span class="status" [ngClass]="statusClass(line.status)">{{ statusLabel(line.status) }}</span>
                  <div class="questions" *ngFor="let q of line.questions">
                    <mat-icon class="q-icon" [class.stale]="q.stale">{{ q.stale ? 'history' : 'help' }}</mat-icon>
                    <span><b>{{ q.actor }}</b>（修订#{{ q.revisionSeq }}）：{{ q.note }}
                      <em class="stale-text" *ngIf="q.stale">— 重放时该行已是新稿，疑问作过期参考保留</em>
                    </span>
                  </div>
                  <div class="ask-row">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic">
                      <input matInput [(ngModel)]="questionDrafts[line.id]" placeholder="记下对这句台词的疑问…">
                    </mat-form-field>
                    <button mat-button color="primary" (click)="ask(line.id)">
                      <mat-icon>record_voice_over</mat-icon>{{ online ? '提交疑问' : '离线记疑问' }}
                    </button>
                  </div>
                </div>
                <div class="line-actions">
                  <button mat-button color="primary" [disabled]="line.status === 'accepted'" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" [disabled]="line.status === 'returned'" (click)="reviewLine(line.id, 'returned')">退回</button>
                  <button mat-button [disabled]="line.status === 'pending'" (click)="reviewLine(line.id, 'pending')">重置</button>
                </div>
              </article>
            </mat-tab>

            <!-- 待裁决：只显示当前版本自己的冲突 -->
            <mat-tab [label]="'待裁决 (' + activeVersion.conflicts.length + ')'">
              <p class="tab-hint" *ngIf="!activeVersion.conflicts.length">本版本没有待裁决行。待裁决跟着版本走：切到别的版本时，那些冲突仍留在原版本里。</p>
              <article class="conflict" *ngFor="let conflict of activeVersion.conflicts">
                <div class="conflict-col">
                  <span class="conflict-tag">排练稿 · {{ statusLabel(conflict.currentStatus) }}</span>
                  <p>{{ conflict.currentText }}</p>
                </div>
                <mat-icon>compare_arrows</mat-icon>
                <div class="conflict-col incoming">
                  <span class="conflict-tag">{{ conflict.playwright }} 修订 #{{ conflict.revisionSeq }}</span>
                  <p>{{ conflict.incomingText }}</p>
                </div>
                <div class="conflict-actions">
                  <button mat-flat-button color="primary" (click)="resolve(conflict.lineId, 'takeIncoming')">采用新稿</button>
                  <button mat-stroked-button color="warn" (click)="resolve(conflict.lineId, 'keepCurrent')">保留排练稿</button>
                </div>
              </article>
            </mat-tab>

            <!-- 舞台提示 -->
            <mat-tab [label]="'舞台提示 (' + activeVersion.cues.length + ')'">
              <article class="line" *ngFor="let cue of activeVersion.cues">
                <div class="line-body">
                  <b>{{ cue.scene }}</b><p>{{ cue.text }}</p>
                  <span class="status" [ngClass]="statusClass(cue.status)">{{ statusLabel(cue.status) }}</span>
                </div>
                <div class="line-actions">
                  <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                </div>
              </article>
            </mat-tab>
          </mat-tab-group>
        </mat-card>

        <div class="side">
          <!-- 版本对比 -->
          <mat-card class="compare">
            <mat-card-title>版本对比</mat-card-title>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="base-select">
              <mat-label>基准版本</mat-label>
              <mat-select [(ngModel)]="baselineId">
                <mat-option *ngFor="let version of state.versions" [value]="version.id">{{ version.label }}</mat-option>
              </mat-select>
            </mat-form-field>
            <p class="version-name">{{ baselineVersion?.label }} → {{ activeVersion.label }}</p>
            <div class="diff" *ngFor="let diff of diffs" [ngClass]="'diff-' + diff.kind">
              <span class="diff-kind">{{ diffLabel(diff.kind) }}</span>
              <span class="diff-body">
                <ng-container *ngIf="diff.baseText"><s>{{ diff.baseText }}</s><br></ng-container>
                <b *ngIf="diff.currentText">{{ diff.currentText }}</b>
              </span>
            </div>
          </mat-card>

          <!-- 离线疑问队列 -->
          <mat-card class="outbox-card">
            <mat-card-title>演员离线疑问队列（{{ queuedOutbox.length }} 待重放）</mat-card-title>
            <p class="tab-hint">离线记下的疑问各带修订序号与目标版本，恢复网络后按序号顺序在最新排练稿上逐条重新比对。</p>
            <button mat-flat-button color="primary" [disabled]="!queuedOutbox.length" (click)="replay()">
              <mat-icon>sync</mat-icon>立即按顺序重放
            </button>
            <article class="outbox-item" *ngFor="let item of state.outbox">
              <div>
                <span class="outbox-state" [ngClass]="'out-' + item.state">{{ outboxStateLabel(item.state) }}</span>
                <b>{{ item.actor }}</b> · 修订#{{ item.revisionSeq }}
                <p>{{ item.note }}</p>
                <small>目标：{{ versionLabel(item.targetVersionId) }} · 记录时文本「{{ item.lineTextAtRecord }}」</small>
                <small *ngIf="item.replayVersionLabel">重放于：{{ item.replayVersionLabel }}</small>
              </div>
              <button mat-icon-button *ngIf="item.state === 'queued'" matTooltip="丢弃" (click)="discard(item.id)"><mat-icon>delete_outline</mat-icon></button>
            </article>
          </mat-card>
        </div>
      </section>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; gap: 10px; }
    .spacer { flex: 1; }
    .online-btn { margin-right: 8px; }
    .online-btn mat-icon { font-size: 18px; width: 18px; height: 18px; margin-right: 4px; }
    main { max-width: 1240px; margin: 20px auto; padding: 0 18px 60px; }
    .summary { margin-bottom: 16px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
    .active-chip { border-width: 2px; }
    .conflict-badge { margin-left: 8px; color: #b45309; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .merge-summary { margin-top: 12px; color: #374151; background: #f3f4f6; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr); gap: 16px; align-items: start; }
    .side { display: flex; flex-direction: column; gap: 16px; }
    .line, .conflict, .outbox-item { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid #e5e7eb; }
    .line-body { flex: 1; min-width: 0; }
    .line-body p { margin: 6px 0; font-size: 16px; line-height: 1.6; }
    .line-actions { display: flex; flex-direction: column; }
    .status { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
    .st-accepted { color: #166534; background: #dcfce7; }
    .st-returned { color: #991b1b; background: #fee2e2; }
    .st-pending { color: #92400e; background: #fef3c7; }
    .actor-row { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
    .actor-row mat-form-field, .ask-row mat-form-field { width: 220px; }
    .ask-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .ask-row mat-form-field { flex: 1; }
    .questions { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: #374151; background: #eff6ff; border-radius: 8px; padding: 6px 10px; margin-top: 6px; }
    .q-icon { font-size: 18px; width: 18px; height: 18px; color: #1d4ed8; }
    .q-icon.stale { color: #9ca3af; }
    .stale-text { color: #6b7280; }
    .tab-hint { color: #6b7280; font-size: 13px; }
    .legacy-tag { font-size: 11px; font-weight: normal; background: #ede9fe; color: #5b21b6; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
    .conflict { align-items: center; background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 12px; margin: 10px 0; }
    .conflict-col { flex: 1; min-width: 0; }
    .conflict-col p { margin: 6px 0 0; line-height: 1.5; }
    .conflict-col.incoming p { color: #1d4ed8; }
    .conflict-tag { font-size: 11px; color: #92400e; }
    .conflict-actions { display: flex; flex-direction: column; gap: 6px; }
    .base-select { width: 100%; }
    .version-name { padding: 10px; background: #f3f4f6; border-radius: 8px; font-size: 13px; }
    .diff { display: flex; gap: 10px; border-bottom: 1px solid #e5e7eb; padding: 10px 0; font-size: 13px; }
    .diff-kind { flex: 0 0 44px; font-size: 11px; height: fit-content; padding: 2px 6px; border-radius: 8px; }
    .diff-same .diff-kind { background: #f3f4f6; color: #6b7280; }
    .diff-changed .diff-kind { background: #fef3c7; color: #92400e; }
    .diff-added .diff-kind { background: #dcfce7; color: #166534; }
    .diff-removed .diff-kind { background: #fee2e2; color: #991b1b; }
    .diff s { color: #9ca3af; }
    .outbox-card { max-height: 560px; overflow: auto; }
    .outbox-item { align-items: center; }
    .outbox-item small { display: block; color: #6b7280; margin-top: 4px; }
    .outbox-state { font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-right: 6px; }
    .out-queued { background: #fef3c7; color: #92400e; }
    .out-applied { background: #dcfce7; color: #166534; }
    .out-stale { background: #e5e7eb; color: #4b5563; }
    .out-gone { background: #fee2e2; color: #991b1b; }
    .out-discarded { background: #f3f4f6; color: #9ca3af; }
    /* 提词模式 */
    .teleprompter { min-height: 100vh; background: #0b0f19; color: #f9fafb; padding: 32px 6vw 80px; }
    .tp-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
    .tp-head h2 { margin: 0; }
    .tp-head p { color: #9ca3af; margin: 8px 0 0; }
    .tp-lines { list-style: none; margin: 40px 0 0; padding: 0; }
    .tp-lines li { display: flex; gap: 28px; align-items: baseline; margin-bottom: 34px; }
    .tp-role { flex: 0 0 4.5em; color: #fbbf24; font-size: 30px; text-align: right; }
    .tp-text { font-size: 40px; line-height: 1.5; }
    .tp-lines li.pending .tp-text { color: #cbd5e1; }
    .tp-lines li.pending::after { content: '待确认'; font-size: 14px; color: #fbbf24; border: 1px solid #fbbf24; border-radius: 10px; padding: 2px 10px; margin-left: 8px; white-space: nowrap; }
    .tp-returned { color: #f87171; margin-top: 30px; }
    @media (max-width: 860px) {
      .workspace { grid-template-columns: 1fr; }
      .tp-text { font-size: 30px; }
      .tp-role { font-size: 22px; }
    }
  `],
})
export class AppComponent implements OnInit, OnDestroy {
  state!: ScriptState;
  activeVersion: ScriptVersion | undefined;
  baselineId: string | undefined;
  actorName = '苏青';
  questionDrafts: Record<string, string> = {};
  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: true }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ script: ScriptState }>, private readonly snackBar: MatSnackBar) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.store.select('script').subscribe((state) => {
      this.state = state;
      this.activeVersion = state.versions.find((version) => version.id === state.activeVersionId);
      if (!this.baselineId || !state.versions.some((version) => version.id === this.baselineId)) {
        this.baselineId = state.versions.find((version) => version.id !== state.activeVersionId)?.id ?? state.activeVersionId;
      }
      persistState(state);
    });
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  get online(): boolean { return this.state?.online ?? true; }
  get rehearsalMode(): boolean { return this.state?.rehearsalMode ?? false; }
  get queuedOutbox() { return (this.state?.outbox ?? []).filter((item) => item.state === 'queued'); }
  get baselineVersion() { return this.state.versions.find((version) => version.id === this.baselineId); }
  get diffs(): LineDiff[] { return diffVersions(this.baselineVersion, this.activeVersion); }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  reviewLine(id: string, decision: 'accepted' | 'returned' | 'pending') { this.store.dispatch(reviewLine({ id, decision })); }
  reviewCue(id: string, decision: 'accepted' | 'returned' | 'pending') { this.store.dispatch(reviewCue({ id, decision })); }
  resolve(lineId: string, choice: 'takeIncoming' | 'keepCurrent') {
    this.store.dispatch(resolveLineConflict({ lineId, choice }));
    this.snackBar.open(choice === 'takeIncoming' ? '已采用编剧新稿，该行重新进入待确认，等舞台监督定性。' : '已保留排练稿与原结论，下轮合并不再重复挂起。', '好', { duration: 2600 });
  }
  discard(id: string) { this.store.dispatch(discardOutboxItem({ id })); }

  toggleOnline() { this.store.dispatch(setOnline({ online: !this.online })); }

  statusLabel(status: string): string {
    return status === 'accepted' ? '已采纳' : status === 'returned' ? '已退回' : '待确认';
  }
  statusClass(status: string): string { return `st-${status}`; }
  diffLabel(kind: LineDiff['kind']): string {
    return kind === 'same' ? '相同' : kind === 'changed' ? '改动' : kind === 'added' ? '新增' : '删除';
  }
  outboxStateLabel(state: string): string {
    return state === 'queued' ? '待重放' : state === 'applied' ? '已挂接' : state === 'stale' ? '已过期' : state === 'gone' ? '目标不存在' : '已丢弃';
  }
  versionLabel(id: string): string { return this.state.versions.find((version) => version.id === id)?.label ?? '（版本已不在）'; }
  teleprompterLines(version: ScriptVersion) { return version.lines.filter((line) => line.status !== 'returned'); }
  returnedLines(version: ScriptVersion) { return version.lines.filter((line) => line.status === 'returned'); }

  ask(lineId: string) {
    const note = (this.questionDrafts[lineId] ?? '').trim();
    if (!note) { this.snackBar.open('先写下疑问内容。', '好', { duration: 1800 }); return; }
    const seq = this.state.revisionSeq;
    this.store.dispatch(recordQuestion({ lineId, actor: this.actorName.trim() || '未署名演员', note }));
    this.questionDrafts[lineId] = '';
    this.snackBar.open(this.online ? `疑问已挂到该行（修订#${seq}）。` : `已离线记下（修订#${seq}），恢复网络后按顺序重放。`, '好', { duration: 2600 });
  }

  mergeSampleDraft() {
    this.store.dispatch(mergePlaywrightDraft({ draft: samplePlaywrightDraft(this.state.revisionSeq) }));
    this.snackBar.open('编剧修订稿已并入当前版本：未改的行保留原结论，冲突行已挂待裁决。', '查看', { duration: 3200 });
  }

  replay() {
    // 先在当前快照上算一遍结果用于提示，再交给 reducer 落库（纯函数结果一致）。
    this.store.select('script').pipe(take(1)).subscribe((snapshot) => {
      const result = replayOutbox(snapshot);
      this.store.dispatch(replayQuestions());
      this.snackBar.open(`重放完成：挂接 ${result.applied} 条，过期参考 ${result.stale} 条，目标不存在 ${result.gone} 条。`, '好', { duration: 3200 });
    });
  }

  onDraftFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const draft = parseDraftFile(String(reader.result));
      if (draft) {
        this.store.dispatch(mergePlaywrightDraft({ draft }));
        this.snackBar.open(`编剧稿「${draft.playwright} #${draft.revisionSeq}」已按三路合并进入当前版本。`, '好', { duration: 3000 });
      } else {
        this.snackBar.open('文件不是有效的编剧稿（需要 lines 数组）。', '好', { duration: 3000 });
      }
    };
    reader.readAsText(file);
    (event.target as HTMLInputElement).value = '';
  }

  onArchiveFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result));
        if (isLegacyArchive(raw)) {
          this.store.dispatch(importLegacyArchive({ archive: raw }));
          this.snackBar.open('历史存档已迁移：无标记行补派了稳定标记，现有记录全部保留，可对比、可提词。', '好', { duration: 3400 });
        } else {
          this.snackBar.open('无法识别的存档格式。', '好', { duration: 2600 });
        }
      } catch {
        this.snackBar.open('文件不是合法 JSON。', '好', { duration: 2600 });
      }
    };
    reader.readAsText(file);
    (event.target as HTMLInputElement).value = '';
  }
}
