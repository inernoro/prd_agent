import { useCallback, useContext, useEffect, useRef } from 'react';
import { Flame, HardDrive, Snowflake, Trash2 } from 'lucide-react';

import { useSettingsSessionState } from '../useSettingsSessionState';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, Section } from '../components';
import { SourceRetentionPreview } from '../components/SourceRetentionPreview';
import { BackupRetentionPanel } from '../components/BackupRetentionPanel';
import { AcceptanceRetentionPanel } from '../components/AcceptanceRetentionPanel';
import { ImageCachePanel } from '../components/ImageCachePanel';
import { HostCapacityPanel } from '../components/HostCapacityPanel';

interface SchedulerConfig {
  enabled: boolean;
  maxHotBranches: number;
  idleTTLSeconds: number;
  tickIntervalSeconds: number;
  pinnedBranches: string[];
}

interface SchedulerSnapshot {
  enabled?: boolean;
  // scheduler 未挂载时后端可能返回 config: null —— 全部按可选处理（Codex P2）。
  config?: SchedulerConfig | null;
  hot?: Array<{ slug: string; lastAccessedAt: string | undefined; pinned: boolean }>;
  cold?: Array<{ slug: string; lastAccessedAt: string | undefined }>;
  capacityUsage?: { current: number; max: number | null };
  memoryCapacity?: { scope: 'host' | 'docker'; totalMB: number; usedMB: number; limitMB: number } | null;
  resourcePressure?: 'ample' | 'pressure' | 'unknown';
  occupancy?: Array<{ slug: string; state: string; reason: string }>;
  protections?: Array<{ slug: string; source: string; active: boolean; reviewRequired: boolean;
    pin?: { kind: string; actor: string; reason: string; expiresAt?: string; authorizationRef?: string } }>;
}

interface JanitorConfig {
  enabled: boolean;
  worktreeTTLDays: number;
  diskWarnPercent: number;
  sweepIntervalSeconds: number;
}

interface JanitorSnapshot {
  enabled?: boolean;
  reclaimLock?: { holder: string | null; since: number | null };
  config?: JanitorConfig | null;
  dryRun?: { wouldRemove: string[]; wouldSkip: string[] };
  disk?: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  lastSweep?: { at: string; reclaimDeferred?: { heldBy: string; heldForMs: number };
    capacity?: { fullRecheckScheduled?: boolean; fullRechecksRemaining?: number };
    deploymentSources?: { filesystem?: {
    beforeAvailableBytes: number | null; afterAvailableBytes: number | null; netAvailableBytesDelta: number | null;
  } } } | null;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: false,
  maxHotBranches: 3,
  idleTTLSeconds: 900,
  tickIntervalSeconds: 60,
  pinnedBranches: [],
};

const DEFAULT_JANITOR_CONFIG: JanitorConfig = {
  enabled: true,
  worktreeTTLDays: 7,
  diskWarnPercent: 80,
  sweepIntervalSeconds: 3600,
};

const inputClass =
  'min-h-[3.25rem] w-32 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring';

type SchedulerDraft = { enabled: boolean; minutes: string; maxHot: string | null };
type JanitorDraft = { enabled: boolean; days: string };
type PolicyState<S, D> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; scope: object | null; snapshot: S; saved: D; draft: D; readError: string; saveError: string; unknown: boolean; unconfirmed?: D };
const equalDraft = <D,>(left: D, right: D) => JSON.stringify(left) === JSON.stringify(right);
function schedulerDraft(snapshot: SchedulerSnapshot): SchedulerDraft {
  const config = snapshot.config ?? DEFAULT_SCHEDULER_CONFIG;
  return { enabled: snapshot.enabled ?? config.enabled, minutes: String(Math.round(config.idleTTLSeconds / 60)),
    maxHot: snapshot.memoryCapacity === undefined ? String(config.maxHotBranches) : null };
}
function janitorDraft(snapshot: JanitorSnapshot): JanitorDraft {
  const config = snapshot.config ?? DEFAULT_JANITOR_CONFIG;
  return { enabled: snapshot.enabled ?? config.enabled, days: String(config.worktreeTTLDays) };
}
function schedulerBody(draft: SchedulerDraft) {
  const minutes = Number(draft.minutes);
  if (!draft.minutes.trim() || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('空闲超时必须为 1–1440 分钟的整数');
  const settings = { enabled: draft.enabled, idleTTLSeconds: minutes * 60 };
  if (draft.maxHot === null) return settings;
  const maxHot = Number(draft.maxHot);
  if (!draft.maxHot.trim() || !Number.isInteger(maxHot) || maxHot < 1 || maxHot > 25) throw new Error('最大热分支数必须为 1–25 的整数');
  return { ...settings, maxHotBranches: maxHot };
}
function janitorBody(draft: JanitorDraft) {
  const days = Number(draft.days);
  if (!draft.days.trim() || !Number.isInteger(days) || days < 1 || days > 7) throw new Error('过期删除天数必须为 1–7 的整数');
  return { enabled: draft.enabled, worktreeTTLDays: days };
}

/** 每项策略独立读写、独立确认，不把两次写入伪装为一个事务。 */
function useRuntimePolicy<S extends { config?: object | null }, D extends object>(name: string, readPath: string, writePath: string, normalize: (snapshot: S) => D, serialize: (draft: D) => object, onToast: (message: string) => void) {
  const { status: scope } = useContext(ConsoleAuthContext);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [state, setState] = useSettingsSessionState<PolicyState<S, D>>(`policy:${readPath}`, { status: 'loading' }, value => value.status === 'ok' && value.unknown, { keepSession: true });
  const [busy, setBusy] = useSettingsSessionState<boolean>(`policy:${readPath}:busy`, false, Boolean);
  const beginRead = useSettingsReadRequest();
  const load = useCallback(async (preserve = false) => {
    const signal = beginRead();
    if (!preserve) setState({ status: 'loading' });
    try {
      const snapshot = await apiRequest<S>(readPath, { signal });
      if (signal.aborted) return;
      const saved = normalize(snapshot);
      setState(current => current.status === 'ok' && current.scope === scope && preserve
        ? { ...current, snapshot, saved, draft: equalDraft(current.draft, current.saved) ? saved : current.draft, readError: '', saveError: current.unknown && !equalDraft(saved, current.unconfirmed) ? current.saveError : '', unknown: current.unknown && !equalDraft(saved, current.unconfirmed) }
        : { status: 'ok', scope, snapshot, saved, draft: saved, readError: '', saveError: '', unknown: false });
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState(current => current.status === 'ok' && current.scope === scope && preserve ? { ...current, readError: message } : { status: 'error', message });
    }
  }, [beginRead, normalize, readPath, scope]);
  useEffect(() => { void load(true); }, [load]);
  const update = (patch: Partial<D>) => setState(current => current.status === 'ok' && current.scope === scope ? { ...current, draft: { ...current.draft, ...patch }, saveError: current.unknown ? current.saveError : '' } : current);
  async function save(): Promise<void> {
    if (state.status !== 'ok' || state.scope !== scope || !state.snapshot.config || busy || state.unknown || state.readError) return;
    const submitted = state.draft, requestScope = scope;
    let body: object;
    try { body = serialize(submitted); }
    catch (err) { setState(current => current.status === 'ok' ? { ...current, saveError: err instanceof Error ? err.message : String(err) } : current); return; }
    setBusy(true);
    try {
      const snapshot = await apiRequest<S>(writePath, { method: 'PUT', body });
      if (!snapshot.config) throw new Error('服务没有返回保存后的配置');
      if (alive.current && currentScope.current === requestScope) beginRead.cancel();
      const saved = normalize(snapshot);
      setState(current => current.status === 'ok' && current.scope === requestScope ? { ...current, snapshot, saved, draft: equalDraft(current.draft, submitted) ? saved : current.draft, readError: '', saveError: '', unknown: false } : current);
      if (alive.current && currentScope.current === requestScope) onToast(`${name}已保存并立即生效`);
    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setState(current => current.status === 'ok' && current.scope === requestScope ? { ...current, unknown, unconfirmed: unknown ? submitted : undefined, saveError: `${unknown ? '保存结果未确认，请重新读取核对，勿重复提交' : '保存被拒绝'}：${err instanceof Error ? err.message : String(err)}。当前草稿已保留。` } : current);
    } finally { setBusy(false); }
  }
  useEffect(() => {
    if (state.status !== 'ok' || !state.unknown && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [state, busy]);
  const ready = state.status === 'ok' && state.scope === scope ? state : null;
  return { state, ready, busy, load, update, save, dirty: ready ? !equalDraft(ready.draft, ready.saved) : false };
}

export function SchedulerTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const scheduler = useRuntimePolicy('自动冷却规则', '/api/scheduler/state', '/api/scheduler/config', schedulerDraft, schedulerBody, onToast);
  const janitor = useRuntimePolicy('过期删除规则', '/api/janitor/state', '/api/janitor/config', janitorDraft, janitorBody, onToast);
  const s = scheduler.ready, j = janitor.ready;
  const memory = s?.snapshot.memoryCapacity;
  const dynamic = memory !== undefined;
  const cold = s?.snapshot.cold;
  const removal = j?.snapshot.dryRun?.wouldRemove, skipped = j?.snapshot.dryRun?.wouldSkip;
  const validJanitorDays = Boolean(j?.draft.days.trim()) && Number.isInteger(Number(j?.draft.days)) && Number(j?.draft.days) >= 1 && Number(j?.draft.days) <= 7;
  const destructiveChange = validJanitorDays && j && j.draft.enabled && (!j.saved.enabled || Number(j.draft.days) < Number(j.saved.days));
  const janitorSave = <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" onClick={() => void janitor.save()} disabled={janitor.busy || !janitor.dirty || !j?.snapshot.config || j.unknown || Boolean(j.readError)}>{janitor.busy ? '正在保存' : '保存过期删除规则'}</Button>;
  return <div className="space-y-5">
    <Section title="调度器与工作区保留" description="配置影响全部项目。自动冷却和工作区过期删除分别保存。">
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground"><span className="inline-flex items-center gap-2"><Flame />热池记录 {s?.snapshot.capacityUsage?.current ?? '未确认'}</span><span className="inline-flex items-center gap-2"><Snowflake />冷分支 {cold ? cold.length : '未确认'}</span><span className="inline-flex items-center gap-2"><Trash2 />当前规则待删除 {removal ? removal.length : '未确认'}</span><span className="inline-flex items-center gap-2"><HardDrive />磁盘 {j?.snapshot.disk ? `${j.snapshot.disk.usedPercent}%` : '未确认'}</span></div>
      <HeatPoolGovernance snapshot={s?.snapshot} />
      <ReclaimExecutionStatus snapshot={j?.snapshot} readError={j?.readError} />

    </Section>
    <Section title="自动冷却" description={dynamic ? '达到内存上限时，新启动等待资源释放。自动冷却只处理已超过空闲时长且未受保护的预览。' : '空闲超过时长或热分支达到上限时，冷却最久未访问的非固定分支。'} actions={<Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" size="sm" disabled={scheduler.busy} onClick={() => void scheduler.load(true)}>重新读取冷却规则</Button>}>
      {scheduler.state.status === 'loading' ? <LoadingBlock label="读取冷却规则" /> : scheduler.state.status === 'error' ? <ErrorBlock message={scheduler.state.message} /> : !s ? <LoadingBlock label="读取当前会话冷却规则" /> : !s.snapshot.config ? <p className="text-sm text-muted-foreground">调度服务未启动，当前没有可编辑配置。请确认服务运行后重新读取。</p> : <div className="space-y-4">
        <p role="status" className="text-sm text-muted-foreground">{s.unknown ? '保存结果未确认' : `已确认状态：${s.saved.enabled ? '已启用' : '已停用'}`}{scheduler.dirty && !s.unknown ? ' · 草稿未保存' : ''}</p>
        <fieldset disabled={scheduler.busy} className="space-y-4"><label className="flex min-h-[3.25rem] items-center gap-2 text-sm"><input type="checkbox" checked={s.draft.enabled} onChange={event => scheduler.update({ enabled: event.target.checked })} className="h-4 w-4 accent-primary" />允许自动冷却（保存后生效）</label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-2 text-sm">空闲自动下线时长（分钟）<input aria-label="空闲自动下线时长（分钟）" type="number" min={1} max={1440} className={inputClass} value={s.draft.minutes} onChange={event => scheduler.update({ minutes: event.target.value })} /><span className="text-xs text-muted-foreground">已确认值 {s.saved.minutes} 分钟，允许 1–1440 分钟。</span></label>
            {dynamic ? <div className="space-y-2 text-sm">
              <p>动态内存上限</p>
              <p className="text-muted-foreground">{memory
                ? `${memory.scope === 'host' ? '宿主' : 'Docker'}已用 ${(memory.usedMB / 1024).toFixed(1)} GiB，运行上限 ${(memory.limitMB / 1024).toFixed(1)} GiB（总额度的 ${Math.round(memory.limitMB / memory.totalMB * 100)}%）。`
                : '内存读数待确认，新启动暂缓。'}</p>
            </div> : <label className="grid gap-2 text-sm">最大热分支数<input aria-label="最大热分支数" type="number" min={1} max={25} className={inputClass} value={s.draft.maxHot ?? ''} onChange={event => scheduler.update({ maxHot: event.target.value })} /><span className="text-xs text-muted-foreground">已确认值 {s.saved.maxHot}，允许 1–25。</span></label>}
          </div>
        </fieldset>
        {s.snapshot.config.pinnedBranches.length ? <div className="flex flex-wrap gap-2 text-sm"><span>固定分支：</span>{s.snapshot.config.pinnedBranches.map(slug => <CodePill key={slug}>{slug}</CodePill>)}</div> : null}
        {s.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{s.readError}。当前显示上次结果。</p> : null}{s.saveError ? <p role="alert" className="text-sm text-destructive">{s.saveError}</p> : null}
        <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" onClick={() => void scheduler.save()} disabled={scheduler.busy || !scheduler.dirty || s.unknown || Boolean(s.readError)}>{scheduler.busy ? '正在保存' : '保存冷却规则'}</Button>
      </div>}
    </Section>
    <Section title="过期删除" description="启用后，超过保留期且未受固定、标记或默认分支保护的容器与工作区将按计划删除。Git 历史保留，未提交的工作区内容不能依此恢复。" actions={<Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" size="sm" disabled={janitor.busy} onClick={() => void janitor.load(true)}>重新读取删除规则</Button>}>
      {janitor.state.status === 'loading' ? <LoadingBlock label="读取过期删除规则" /> : janitor.state.status === 'error' ? <ErrorBlock message={janitor.state.message} /> : !j ? <LoadingBlock label="读取当前会话删除规则" /> : !j.snapshot.config ? <p className="text-sm text-muted-foreground">清理服务未启动，当前没有可编辑配置。请确认服务运行后重新读取。</p> : <div className="space-y-4">
        <p role="status" className="text-sm text-muted-foreground">{j.unknown ? '保存结果未确认' : `已确认状态：${j.saved.enabled ? '已启用' : '已停用'}`}{janitor.dirty && !j.unknown ? ' · 草稿未保存' : ''}</p>
        <fieldset disabled={janitor.busy} className="space-y-4"><label className="flex min-h-[3.25rem] items-center gap-2 text-sm"><input type="checkbox" checked={j.draft.enabled} onChange={event => janitor.update({ enabled: event.target.checked })} className="h-4 w-4 accent-primary" />允许过期删除（保存后生效）</label><label className="grid gap-2 text-sm">工作区保留天数<input aria-label="工作区保留天数" type="number" min={1} max={7} className={inputClass} value={j.draft.days} onChange={event => janitor.update({ days: event.target.value })} /><span className="text-xs text-muted-foreground">已确认值 {j.saved.days} 天，允许 1–7 天。</span></label></fieldset>
        <p className="text-sm text-warn">当前已保存规则的候选：{removal ? `${removal.length} 个待删除` : '未确认'}，{skipped ? `${skipped.length} 个受保护` : '保护数量未确认'}。修改草稿后，这些数量不代表新规则的执行结果。</p>
        {j.snapshot.disk ? <p className="text-sm text-muted-foreground">磁盘告警阈值 {j.snapshot.config.diskWarnPercent}%，当前使用 {j.snapshot.disk.usedPercent}%。</p> : null}
        {removal && removal.length > 0 ? <details><summary className="cursor-pointer text-sm">查看当前规则待删除的分支</summary><div className="mt-2 flex flex-wrap gap-2">{removal.map(slug => <CodePill key={slug}>{slug}</CodePill>)}</div></details> : null}
        {j.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{j.readError}。当前显示上次结果。</p> : null}{j.saveError ? <p role="alert" className="text-sm text-destructive">{j.saveError}</p> : null}
        {destructiveChange ? <ConfirmAction scopeKey={JSON.stringify({ draft: j.draft, saved: j.saved })} title="保存过期删除规则？" description={`保留期设为 ${j.draft.days} 天，保存后立即用于定时清理全部项目中未受保护的分支容器与工作区。当前候选仅基于旧规则，不代表新规则执行结果。`} confirmLabel="保存删除规则" onConfirm={janitor.save} disabled={janitor.busy || j.unknown || Boolean(j.readError)} trigger={janitorSave} /> : janitorSave}
      </div>}
    </Section>
    <HostCapacityPanel />
    <Section title="部署源码磁盘治理">
      <p className="text-sm text-muted-foreground">
        最近一轮文件系统净可用空间变化：{j?.snapshot.lastSweep?.deploymentSources?.filesystem?.netAvailableBytesDelta == null
          ? '尚无已确认读数'
          : `${j.snapshot.lastSweep.deploymentSources.filesystem.netAvailableBytesDelta.toLocaleString()} 字节`}。
        该读数包含同时发生的写入，不能将候选估计值或删除数量当作实际释放量。
      </p>
      <SourceRetentionPreview />
      <BackupRetentionPanel />
      <AcceptanceRetentionPanel />
      <ImageCachePanel />
    </Section>
  </div>;
}

function ReclaimExecutionStatus({ snapshot, readError }: { snapshot?: JanitorSnapshot; readError?: string }): JSX.Element {
  const deferred = snapshot?.lastSweep?.reclaimDeferred;
  const recheck = snapshot?.lastSweep?.capacity;
  return <div className="mt-4 space-y-2 text-sm">
    <h3 className="font-medium">回收执行状态</h3>
    {readError ? <p role="status" className="text-warn">最新读取失败，以下为上次已确认结果，当前执行情况未确认。</p> : null}
    <p className="text-muted-foreground">{snapshot?.reclaimLock === undefined
      ? '当前版本未提供回收互斥状态，执行情况未知。'
      : snapshot.reclaimLock.holder
        ? <>本次读取时，回收锁由 <CodePill>{snapshot.reclaimLock.holder}</CodePill> 持有。</>
        : '本次读取时回收锁空闲。'}</p>
    {deferred ? <p role="status" className="text-warn">
      上轮回收因互斥锁占用而延期，持有任务为 <CodePill>{deferred.heldBy}</CodePill>。
      {recheck?.fullRecheckScheduled === true ? '已安排有次数上限的延迟复查。' : recheck?.fullRecheckScheduled === false ? '本周期未安排延迟复查，下一常规周期重试。' : '复查调度状态未提供。'}
      {recheck?.fullRechecksRemaining === undefined ? null : ` 本周期剩余复查次数 ${recheck.fullRechecksRemaining}。`}
    </p> : null}
  </div>;
}


function HeatPoolGovernance({ snapshot }: { snapshot?: SchedulerSnapshot }): JSX.Element {
  const pressure = snapshot?.resourcePressure;
  const occupancyLabels: Record<string, string> = { resident: '已占用', reserved: '预约中', unknown: '待核实', nonresident: '未占用' };
  const labels: Record<string, string> = { user: '手动固定', debug: '调试标记', 'config-pinned': '配置固定', 'default-branch': '默认分支', 'trunk-branch': '主分支', 'release-batch-input': '发布与恢复保护' };
  return <div className="mt-4 space-y-3 text-sm">
    <p className="text-muted-foreground">资源状态：{pressure === 'ample' ? '充裕' : pressure === 'pressure' ? '存在压力' : '待确认'}。</p>
    <div className="space-y-2"><h3 className="font-medium">热池占用与保护</h3>
      {snapshot?.occupancy ? <div className="flex flex-wrap gap-2">{snapshot.occupancy.map(row => <span key={row.slug} className="rounded border border-border px-2 py-1">{row.slug} · {occupancyLabels[row.state] ?? '待核实'} · {row.reason}</span>)}</div> : <p className="text-muted-foreground">占用尚未确认。</p>}
      {snapshot?.protections ? <ul className="space-y-2">{snapshot.protections.map((row, index) => <li key={`${row.slug}-${row.source}-${index}`} className="rounded border border-border p-3">
        <strong>{row.slug}</strong> · {labels[row.source] ?? row.source} · {row.active ? '保护中' : '临时保护已到期'}
        {row.pin ? <div className="mt-1 break-words text-muted-foreground">{row.pin.actor} · {row.pin.reason} · {row.reviewRequired ? '期限及依据待核对' : row.pin.expiresAt ? `到期 ${row.pin.expiresAt}` : '永久固定'}{row.pin.authorizationRef ? ` · 授权 ${row.pin.authorizationRef}` : ''}</div> : row.reviewRequired ? <div className="mt-1 text-muted-foreground">历史记录，期限及依据待核对，继续保留保护。</div> : null}
      </li>)}</ul> : <p className="text-muted-foreground">保护记录尚未确认。</p>}
    </div>
  </div>;
}
