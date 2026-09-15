/*
 * 通知通道（多协议）。
 *
 * 用户 2026-09-15 原话：「这个通知放在右上角增加通知设置，配置哪些出问题通知谁、
 * 支持的协议可以和 map 一样，什么 bark 什么的通知 curl 什么的」。
 *
 * 它要拆掉的是一个很具体的死结：此前唯一的通道是 MAP 站内通知，而接上它得先定
 * 两件只有人能定的事（发给哪个 MAP 账号、用哪个 MAP 实例），于是铃一直没接——
 * 这条链最常见的失败恰恰就是**根本没人去接**。Bark 的 key 是一个人当场就能粘进来的
 * 东西，这条路不等任何决定。
 *
 * 界面上守两条：
 *   - **最小输入**：Bark 只有一个必填框（key），其余全进「高级」；Webhook 只要地址。
 *     有正确默认值的东西不该摆在第一屏上问人（minimal-user-input）。
 *   - **配完当场演练**：没演练过的通道，和没配的通道在真出事那天是一样的。
 *     所以每条通道旁边永远有一个「演练」，而不是把它藏进某个菜单。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, CheckCircle2, Plus, Send, Trash2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';

type ChannelKind = 'bark' | 'webhook' | 'map';
type EventKind = 'business-down' | 'business-recovered' | 'infra-down' | 'infra-recovered';
type ChannelStatus = 'unconfigured' | 'untested' | 'healthy' | 'failing';

const KIND_LABEL: Record<ChannelKind, string> = {
  bark: 'Bark 手机推送',
  webhook: 'Webhook（一条 curl）',
  map: 'MAP 站内通知',
};

/** 事件名后面那句话解释「勾了会收到什么」——只给名字等于让人自己猜。 */
const EVENT_META: Record<EventKind, { label: string; what: string; noisy?: boolean }> = {
  'business-down': { label: '业务故障', what: '你自己加的业务监控判据没过 —— 用户现在用不了' },
  'business-recovered': { label: '业务恢复', what: '之前挂掉的那条业务重新通了' },
  'infra-down': { label: '基础设施故障', what: '容器、端口、预览域名不通 —— 分支预览重建时也会触发', noisy: true },
  'infra-recovered': { label: '基础设施恢复', what: '容器重新起来了 —— 分支预览一天重建几十次，这一档最吵', noisy: true },
};

const STATUS_META: Record<ChannelStatus, { text: string; tone: string }> = {
  unconfigured: { text: '没配齐，不会响', tone: 'text-destructive' },
  untested: { text: '还没演练过，能不能送到是未知数', tone: 'text-warn' },
  healthy: { text: '通着', tone: 'text-ok' },
  failing: { text: '上次没送出去', tone: 'text-destructive' },
};

interface ChannelView {
  id: string; name: string; kind: ChannelKind; enabled: boolean;
  projects: string[]; events: EventKind[];
  bark?: { serverUrl: string; keySet: boolean; keyTail: string; group: string; sound: string; level: string; call: boolean };
  webhook?: { method: string; url: string; contentType: string; bodyTemplate: string; headerNames: string[] };
  map?: { endpoint: string; keyId: string; username: string; privateKeyFingerprint: string };
}
interface StatusView {
  id: string; name: string; kind: string; status: ChannelStatus;
  delivered: number; failed: number; enabled: boolean;
  events: string[]; projects: string[];
  last?: { at: number; ok: boolean; kind: 'alert' | 'drill'; reason?: string; status?: number };
}

const INPUT = 'w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary/50';
const LABEL = 'text-[0.6875rem] text-muted-foreground';

interface DraftState {
  id?: string;
  kind: ChannelKind;
  name: string;
  events: EventKind[];
  projects: string[];
  barkKey: string; barkServerUrl: string; barkGroup: string; barkLevel: string; barkCall: boolean;
  hookUrl: string; hookMethod: string; hookContentType: string; hookBody: string; hookHeaders: string;
  mapEndpoint: string; mapKeyId: string; mapUsername: string; mapPrivateKey: string;
}

function emptyDraft(kind: ChannelKind): DraftState {
  return {
    kind, name: '',
    // 默认只订业务两档。基础设施那两档在有分支预览的实例上会刷屏——2026-09-15
    // 实测：配好一条通道 3 秒内就收到 5 条，全是预览容器的起落。
    // 一条刷屏的铃和一条不响的铃下场一样，都会被关掉。
    events: ['business-down', 'business-recovered'],
    projects: [],
    barkKey: '', barkServerUrl: '', barkGroup: '', barkLevel: '', barkCall: false,
    hookUrl: '', hookMethod: 'POST', hookContentType: '', hookBody: '', hookHeaders: '',
    mapEndpoint: '', mapKeyId: '', mapUsername: '', mapPrivateKey: '',
  };
}

function draftOf(c: ChannelView): DraftState {
  const d = emptyDraft(c.kind);
  return {
    ...d, id: c.id, name: c.name, events: c.events, projects: c.projects,
    barkServerUrl: c.bark?.serverUrl ?? '', barkGroup: c.bark?.group ?? '',
    barkLevel: c.bark?.level ?? '', barkCall: Boolean(c.bark?.call),
    hookUrl: c.webhook?.url ?? '', hookMethod: c.webhook?.method ?? 'POST',
    hookContentType: c.webhook?.contentType ?? '', hookBody: c.webhook?.bodyTemplate ?? '',
    mapEndpoint: c.map?.endpoint ?? '', mapKeyId: c.map?.keyId ?? '', mapUsername: c.map?.username ?? '',
  };
}

/** 「KEY: value」逐行解析成请求头。留空的值表示删掉那个头（读接口从不回值）。 */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

function bodyOf(d: DraftState): Record<string, unknown> {
  const base = { name: d.name, kind: d.kind, events: d.events, projects: d.projects };
  if (d.kind === 'bark') {
    return { ...base, bark: {
      key: d.barkKey, serverUrl: d.barkServerUrl, group: d.barkGroup, level: d.barkLevel, call: d.barkCall,
    } };
  }
  if (d.kind === 'webhook') {
    return { ...base, webhook: {
      url: d.hookUrl, method: d.hookMethod, contentType: d.hookContentType,
      bodyTemplate: d.hookBody, headers: parseHeaders(d.hookHeaders),
    } };
  }
  return { ...base, map: {
    endpoint: d.mapEndpoint, keyId: d.mapKeyId, username: d.mapUsername, privateKey: d.mapPrivateKey,
  } };
}

export function AlarmChannelsPanel({ projects = [] }: { projects?: ReadonlyArray<{ id: string; name: string }> }): JSX.Element {
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [status, setStatus] = useState<StatusView[]>([]);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<{ id: string; ok: boolean; reason?: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await apiRequest<{ channels: ChannelView[]; status: StatusView[] }>('/api/cds-system/alarm-channels');
      setChannels(res.channels); setStatus(res.status); setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const statusOf = useCallback((id: string): StatusView | undefined => status.find((s) => s.id === id), [status]);

  /**
   * 顶部那句结论。
   *
   * 「N 条通道」不是结论，是计数。人要知道的是**出问题时到底会不会有人被通知**，
   * 所以这句话必须从「能不能响」这一侧说，而不是从「配了几条」那一侧。
   */
  const verdict = useMemo(() => {
    const live = status.filter((s) => s.enabled && s.status !== 'unconfigured');
    if (status.length === 0) {
      return { tone: 'bad', text: '一条通知通道都没有 —— 出问题时不会有任何人被通知' };
    }
    if (live.length === 0) {
      return { tone: 'bad', text: `${status.length} 条通道全都停用或没配齐 —— 出问题时不会有任何人被通知` };
    }
    const untested = live.filter((s) => s.status === 'untested').length;
    const failing = live.filter((s) => s.status === 'failing').length;
    if (failing > 0) return { tone: 'bad', text: `${failing} 条通道上次没送出去 —— 现在出问题也可能没人收到` };
    if (untested > 0) return { tone: 'warn', text: `${live.length} 条通道在用，其中 ${untested} 条还没演练过 —— 没演练过的通道，和没配的通道在真出事那天是一样的` };
    return { tone: 'ok', text: `${live.length} 条通道都演练通过 —— 出问题时会响` };
  }, [status]);

  const save = useCallback(async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      await apiRequest(
        draft.id ? `/api/cds-system/alarm-channels/${draft.id}` : '/api/cds-system/alarm-channels',
        { method: draft.id ? 'PUT' : 'POST', body: bodyOf(draft) },
      );
      setDraft(null); setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally { setBusy(false); }
  }, [draft, load]);

  const runDrill = useCallback(async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await apiRequest<{ ok: boolean; reason?: string }>(`/api/cds-system/alarm-channels/${id}/drill`, { method: 'POST', body: {} });
      setDrill({ id, ...res });
      await load();
    } catch (e) {
      setDrill({ id, ok: false, reason: e instanceof ApiError ? e.message : String(e) });
    } finally { setBusy(false); }
  }, [load]);

  const remove = useCallback(async (id: string): Promise<void> => {
    setBusy(true);
    try { await apiRequest(`/api/cds-system/alarm-channels/${id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [load]);

  const toggleEvent = (k: EventKind): void => setDraft((d) => (d
    ? { ...d, events: d.events.includes(k) ? d.events.filter((e) => e !== k) : [...d.events, k] }
    : d));
  const toggleProject = (id: string): void => setDraft((d) => (d
    ? { ...d, projects: d.projects.includes(id) ? d.projects.filter((p) => p !== id) : [...d.projects, id] }
    : d));

  return (
    <div className="flex flex-col gap-3">
      {/* 结论行 */}
      <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-3',
        verdict.tone === 'ok' ? 'border-ok/30 bg-ok-soft/40'
          : verdict.tone === 'warn' ? 'border-warn/40 bg-warn-soft/50'
            : 'border-destructive/40 bg-destructive/10')}>
        <BellRing className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{verdict.text}</span>
        <div className="flex-grow" />
        {draft === null ? (
          <div className="flex items-center gap-1">
            {(['bark', 'webhook', 'map'] as ChannelKind[]).map((k) => (
              <Button key={k} size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(emptyDraft(k)); setErr(null); }}>
                <Plus className="mr-1" />{KIND_LABEL[k]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {err ? <div className="text-[0.6875rem] text-destructive">{err}</div> : null}

      {/* 通道列表 */}
      {channels.map((c) => {
        const st = statusOf(c.id);
        const meta = STATUS_META[st?.status ?? 'unconfigured'];
        const last = st?.last;
        return (
          <div key={c.id} className="flex flex-col gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full',
                st?.status === 'healthy' ? 'bg-ok' : st?.status === 'untested' ? 'bg-warn' : 'bg-destructive')} />
              <span className="text-[0.8125rem] font-medium text-foreground">{c.name}</span>
              <span className="rounded border border-[hsl(var(--hairline))] px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground">
                {KIND_LABEL[c.kind]}
              </span>
              {!c.enabled ? <span className="text-[0.6875rem] text-muted-foreground">已停用</span> : null}
              <span className={cn('text-[0.6875rem]', meta.tone)}>{meta.text}</span>
              <div className="flex-grow" />
              {/* 主动操作靠右 */}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void runDrill(c.id)}>
                <Send className="mr-1" />演练
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(draftOf(c)); setErr(null); }}>编辑</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(c.id)}>
                <Trash2 />
              </Button>
            </div>
            <div className="text-[0.6875rem] leading-5 text-muted-foreground">
              收 {c.events.map((e) => EVENT_META[e].label).join('、')}
              {' · '}
              {c.projects.length === 0 ? '全部项目' : `仅 ${c.projects.join('、')}`}
              {c.kind === 'bark' && c.bark?.keySet ? ` · key 尾号 ${c.bark.keyTail}` : ''}
              {c.kind === 'webhook' && c.webhook ? ` · ${c.webhook.method} ${c.webhook.url}` : ''}
              {c.kind === 'map' && c.map ? ` · ${c.map.username} @ ${c.map.endpoint}` : ''}
            </div>
            {last ? (
              <div className={cn('text-[0.6875rem]', last.ok ? 'text-ok' : 'text-destructive')}>
                上次{last.kind === 'drill' ? '演练' : '告警'}：{last.ok ? '送达' : `失败 —— ${last.reason ?? '原因不明'}`}
              </div>
            ) : null}
            {drill?.id === c.id ? (
              <div className={cn('flex items-center gap-1.5 text-[0.6875rem]', drill.ok ? 'text-ok' : 'text-destructive')}>
                {drill.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                {drill.ok ? '演练已送达 —— 这条链现在是通的，去手机上确认收到了' : `演练失败：${drill.reason ?? '原因不明'}`}
              </div>
            ) : null}
          </div>
        );
      })}

      {/* 编辑器 */}
      {draft ? (
        <div className="flex flex-col gap-3 rounded-lg border border-primary/35 bg-[hsl(var(--surface-raised))] p-4">
          <div className="text-xs font-medium text-foreground">
            {draft.id ? '编辑' : '新建'}：{KIND_LABEL[draft.kind]}
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>通道名字（出问题时你要认得出是谁响了）</span>
            <input className={INPUT} placeholder="我的手机 / 运维群" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>

          {draft.kind === 'bark' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>
                  Bark key（必填，只写不读）—— 在 Bark App 首页那串地址的最后一段
                  {draft.id ? '；留空表示保持原值' : ''}
                </span>
                <input className={INPUT} placeholder="例如 abcdEFGH1234" value={draft.barkKey}
                  onChange={(e) => setDraft({ ...draft, barkKey: e.target.value })} />
              </label>
              <details className="rounded-md border border-[hsl(var(--hairline))] px-2.5 py-2">
                <summary className="cursor-pointer text-[0.6875rem] text-muted-foreground">高级（都有正确的默认值，不用改）</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <input className={INPUT} placeholder="自建 Bark 服务器（留空用官方 api.day.app）" value={draft.barkServerUrl}
                    onChange={(e) => setDraft({ ...draft, barkServerUrl: e.target.value })} />
                  <input className={INPUT} placeholder="分组（默认「CDS 监控」）" value={draft.barkGroup}
                    onChange={(e) => setDraft({ ...draft, barkGroup: e.target.value })} />
                  <input className={INPUT} placeholder="时效级别 critical / active / timeSensitive / passive（留空按事件严重度自动选）"
                    value={draft.barkLevel} onChange={(e) => setDraft({ ...draft, barkLevel: e.target.value })} />
                  <label className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                    <input type="checkbox" checked={draft.barkCall} onChange={(e) => setDraft({ ...draft, barkCall: e.target.checked })} />
                    重要告警响铃 30 秒
                  </label>
                </div>
              </details>
            </>
          ) : null}

          {draft.kind === 'webhook' ? (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>地址（https）</span>
                <input className={INPUT} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." value={draft.hookUrl}
                  onChange={(e) => setDraft({ ...draft, hookUrl: e.target.value })} />
              </label>
              {/* 这句话必须在界面上：地址会被显示出来，带 token 的要知道往哪躲。 */}
              <div className="text-[0.6875rem] leading-5 text-muted-foreground">
                地址会完整显示在这一页（否则没法编辑）。要藏 token 就放进下面的请求头 ——
                请求头的值只写不读，读接口只回名字。
              </div>
              <details className="rounded-md border border-[hsl(var(--hairline))] px-2.5 py-2">
                <summary className="cursor-pointer text-[0.6875rem] text-muted-foreground">高级：方法 / 请求体 / 请求头</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <select className={INPUT} value={draft.hookMethod} onChange={(e) => setDraft({ ...draft, hookMethod: e.target.value })}>
                    {['POST', 'PUT', 'GET'].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input className={INPUT} placeholder="Content-Type（默认 application/json）" value={draft.hookContentType}
                    onChange={(e) => setDraft({ ...draft, hookContentType: e.target.value })} />
                  <textarea className={cn(INPUT, 'h-24 font-mono')}
                    placeholder={'请求体模板（留空用默认）。占位符：{{title}} {{body}} {{level}} {{url}} {{projectId}} {{targetName}} {{message}} {{detectedAt}}'}
                    value={draft.hookBody} onChange={(e) => setDraft({ ...draft, hookBody: e.target.value })} />
                  <textarea className={cn(INPUT, 'h-16 font-mono')}
                    placeholder={'请求头，一行一条：\nAuthorization: Bearer xxx'}
                    value={draft.hookHeaders} onChange={(e) => setDraft({ ...draft, hookHeaders: e.target.value })} />
                </div>
              </details>
            </>
          ) : null}

          {draft.kind === 'map' ? (
            <>
              {([['mapEndpoint', '通知端点', 'https://<你的 MAP>/api/dashboard/notifications/events'],
                 ['mapKeyId', '密钥 ID', '与 MAP 配置里那条的 KeyId 一致'],
                 ['mapUsername', '通知账号', '通知会发给这个 MAP 账号']] as const).map(([k, label, ph]) => (
                <label key={k} className="flex flex-col gap-1">
                  <span className={LABEL}>{label}</span>
                  <input className={INPUT} placeholder={ph} value={draft[k]}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                </label>
              ))}
              <label className="flex flex-col gap-1">
                <span className={LABEL}>私钥（PKCS#8 PEM，只写不读{draft.id ? '；留空表示保持原值' : ''}）</span>
                <textarea className={cn(INPUT, 'h-24 font-mono')} placeholder={'-----BEGIN PRIVATE KEY-----'}
                  value={draft.mapPrivateKey} onChange={(e) => setDraft({ ...draft, mapPrivateKey: e.target.value })} />
              </label>
            </>
          ) : null}

          {/* 哪些出问题通知谁：两个维度，都是勾选。不给条件表达式——那会立刻变成一个自由文本解析器。 */}
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>收哪几类事件</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(EVENT_META) as EventKind[]).map((k) => (
                <button key={k} type="button" title={EVENT_META[k].what} onClick={() => toggleEvent(k)}
                  aria-pressed={draft.events.includes(k)}
                  className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[0.6875rem] transition-colors',
                    draft.events.includes(k) ? 'border-primary/50 bg-primary-soft text-primary-ink'
                      : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground')}>
                  {EVENT_META[k].label}
                  {/* 吵的那两档要标出来，别让人勾完才发现手机在响个不停 */}
                  {EVENT_META[k].noisy ? <span className="text-warn">会吵</span> : null}
                </button>
              ))}
            </div>
            <span className="text-[0.6875rem] leading-5 text-muted-foreground">
              {draft.events.map((e) => EVENT_META[e].what).join('；') || '一类都没勾 —— 保存会被拒；想临时静音请用通道开关'}
            </span>
          </div>

          {projects.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className={LABEL}>管哪些项目（一个都不勾 = 全部项目）</span>
              <div className="flex flex-wrap gap-1.5">
                {projects.map((p) => (
                  <button key={p.id} type="button" onClick={() => toggleProject(p.id)}
                    aria-pressed={draft.projects.includes(p.id)}
                    className={cn('rounded-md border px-2 py-1 text-[0.6875rem] transition-colors',
                      draft.projects.includes(p.id) ? 'border-primary/50 bg-primary-soft text-primary-ink'
                        : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground')}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>保存</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(null); setErr(null); }}>取消</Button>
            <span className="text-[0.6875rem] text-muted-foreground">
              保存后立刻生效，不用重启；存完请紧接着点一次「演练」—— 没演练过的通道，和没配的通道在真出事那天是一样的。
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
