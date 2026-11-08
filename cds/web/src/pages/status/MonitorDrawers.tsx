import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiRequest, ApiError } from '@/lib/api';
import type { UptimeTargetSummary } from '@/lib/monitorCenter';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import './monitor-drawers.css';

type ChannelKind = 'bark' | 'webhook' | 'map';
interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  events: string[];
  projects: string[];
  bark?: { serverUrl: string; keySet: boolean; keyTail: string };
  webhook?: { url: string };
  map?: { username: string };
}
interface ChannelStatus { id: string; status: string }
interface NotificationSettings {
  defaultChannelIds?: string[];
  overrides?: Record<string, string[]>;
}
interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { required?: string[]; properties?: Record<string, unknown>; [key: string]: unknown };
  readOnly: boolean;
  reason?: string;
}
interface Discovery { server: { name: string; version: string }; tools: Tool[]; requestId: string }
interface ChannelsState { channels: Channel[]; status: ChannelStatus[]; settings: NotificationSettings }
interface NotificationsPayload { settings: NotificationSettings; legacyChannel?: Channel & { status: string } }
const KIND_LABEL: Record<ChannelKind, string> = { bark: 'Bark', webhook: 'Webhook', map: 'MAP' };
const STATUS_LABEL: Record<string, string> = {
  healthy: '最近投递成功', failing: '上次未送达', untested: '尚未验证送达', unconfigured: '尚未配齐',
};

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : '操作未完成，请重试；仍失败时请检查服务地址和访问权限。';
}

function destination(channel: Channel): string {
  if (channel.kind === 'map') return channel.map?.username || channel.name;
  if (channel.kind === 'bark') return channel.bark?.keySet ? `手机 · 尾号 ${channel.bark.keyTail}` : '尚未填写推送地址';
  try { return new URL(channel.webhook?.url || '').hostname; } catch { return '尚未填写接收地址'; }
}

function channelState(channels: { channels: Channel[]; status: ChannelStatus[] }, notifications: NotificationsPayload): ChannelsState {
  const legacy = notifications.legacyChannel;
  return {
    channels: legacy && !channels.channels.some((channel) => channel.id === legacy.id) ? [...channels.channels, legacy] : channels.channels,
    status: legacy ? [...channels.status, { id: legacy.id, status: legacy.status }] : channels.status,
    settings: notifications.settings,
  };
}

function useChannels(): {
  data: ChannelsState | null; loading: boolean; error: string | null; reload(): Promise<void>;
} {
  const [data, setData] = useState<ChannelsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const [channels, settings] = await Promise.all([
        apiRequest<{ channels: Channel[]; status: ChannelStatus[] }>('/api/cds-system/alarm-channels'),
        apiRequest<NotificationsPayload>('/api/uptime/notifications'),
      ]);
      setData(channelState(channels, settings));
    } catch (e) { setError(message(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiRequest<{ channels: Channel[]; status: ChannelStatus[] }>('/api/cds-system/alarm-channels', { signal: controller.signal }),
      apiRequest<NotificationsPayload>('/api/uptime/notifications', { signal: controller.signal }),
    ]).then(([channels, settings]) => {
      setData(channelState(channels, settings));
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(message(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return { data, loading, error, reload };
}

function ErrorNotice({ text }: { text: string | null }): JSX.Element | null {
  return text ? <div className="drawer-error" role="alert">{text}</div> : null;
}

function Switch({ checked, label, disabled, onChange }: {
  checked: boolean; label: string; disabled?: boolean; onChange(): void;
}): JSX.Element {
  return <button type="button" className={`sw${checked ? ' on' : ''}`} role="switch" aria-label={label}
    aria-checked={checked} disabled={disabled} onClick={onChange} />;
}

function ManageChannels({ onManage }: { onManage?(): void }): JSX.Element {
  return onManage
    ? <button type="button" className="btn ghost sm" onClick={onManage}>管理通知通道</button>
    : <Link className="btn ghost sm" to="/cds-settings#alarm-notify">管理通知通道</Link>;
}

function ChannelFields({ data, selected, onToggle, onManage, projectId }: {
  data: ChannelsState; selected: string[]; onToggle(id: string): void; onManage?(): void; projectId?: string | null;
}): JSX.Element {
  const projectMatches = (channel: Channel): boolean => projectId === undefined
    || channel.projects.length === 0 || (projectId !== null && channel.projects.includes(projectId));
  return <>
    <div className="fld"><span className="lbl2">通知谁</span>
      <div className="chips">{data.channels.map((channel) => <button type="button" key={channel.id}
        className={`chip tg${selected.includes(channel.id) && projectMatches(channel) ? ' on' : ''}`}
        aria-pressed={selected.includes(channel.id) && projectMatches(channel)}
        disabled={!channel.enabled || !projectMatches(channel)} onClick={() => onToggle(channel.id)}>{channel.name}</button>)}</div>
      {!data.channels.length && <p className="hint">还没有通知对象。先添加手机推送、群 Webhook 或 MAP 通知通道。</p>}
    </div>
    <div className="fld"><span className="lbl2">发到哪里</span>
      <div className="chrows">{data.channels.map((channel) => <div className="chrow" key={channel.id}>
        <span className="chn2">{KIND_LABEL[channel.kind]}</span>
        <span className="dest" title={channel.name}>{destination(channel)} · {!projectMatches(channel) ? '不适用于此项目' : channel.enabled
          ? STATUS_LABEL[data.status.find((item) => item.id === channel.id)?.status || 'untested'] || '状态未知' : '已停用'}</span>
        <Switch checked={selected.includes(channel.id) && projectMatches(channel)} disabled={!channel.enabled || !projectMatches(channel)} label={`通知到${channel.name}`}
          onChange={() => onToggle(channel.id)} />
      </div>)}</div>
      <div className="manage-channels"><ManageChannels onManage={onManage} /></div>
    </div>
  </>;
}

function DeliveryRule({ channels, selected }: { channels: Channel[]; selected: string[] }): JSX.Element {
  const active = channels.filter((channel) => selected.includes(channel.id));
  const recovery = active.filter((channel) => channel.events.some((event) => event.endsWith('-recovered')));
  return <>
    <div className="fld"><span className="lbl2">异常时</span><div className="seg"><span className="on">确认异常后通知</span></div>
      <p className="hint">待确认期间不通知。业务监控的新异常保留 30 分钟通知冷却，按通道订阅的事件发送。</p></div>
    <div className="fld"><span className="lbl2">未恢复时</span><div className="seg"><span className="on">状态未变化时不重复提醒</span></div></div>
    <div className="chrow"><span className="chn2">恢复时</span><span className="dest">{recovery.length
      ? `${recovery.map((channel) => channel.name).join('、')}已订阅恢复通知` : '当前所选通道未订阅恢复通知'}</span></div>
    <p className="hint">业务连续健康 10 分钟后，向本次异常已送达的通道发送恢复通知。通知对象和事件可在“管理通知通道”中调整；保存设置不会发送测试通知。</p>
  </>;
}

interface DrawerBodyProps {
  targets: UptimeTargetSummary[];
  targetId?: string;
  onClose(): void;
  onSaved(): Promise<void>;
  onBusy(busy: boolean): void;
  onManage?(): void;
}

function ConnectDrawer({ targets, onClose, onSaved, onBusy, onManage }: DrawerBodyProps): JSX.Element {
  const id = useId();
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [auth, setAuth] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [projectId, setProjectId] = useState('');
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [customNotify, setCustomNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channels = useChannels();
  const projects = useMemo(() => [...new Map(targets.filter((target) => target.projectId)
    .map((target) => [target.projectId, target.projectName || target.projectId])).entries()], [targets]);
  const recentUrl = targets.find((target) => target.tags?.includes('MCP') && target.probeUrl)?.probeUrl;
  let recentHost = '';
  try { if (recentUrl) recentHost = new URL(recentUrl).hostname; } catch { /* An invalid address is never offered as a recent connection. */ }
  const defaultIds = channels.data?.settings.defaultChannelIds
    ?? channels.data?.channels.filter((channel) => channel.enabled).map((channel) => channel.id) ?? [];
  const effectiveIds = customNotify ? channelIds : defaultIds;
  const toggleChannel = (channelId: string): void => {
    setChannelIds(effectiveIds.includes(channelId) ? effectiveIds.filter((entry) => entry !== channelId) : [...effectiveIds, channelId]);
    setCustomNotify(true);
  };
  const advance = async (): Promise<void> => {
    setError(null);
    if (step === 2) { setStep(3); return; }
    setBusy(true); onBusy(true);
    try {
      if (step === 1) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error('invalid-url'); }
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          setError('请填写完整的 HTTP 或 HTTPS 服务地址，鉴权信息请放在高级设置中。'); return;
        }
        const result = await apiRequest<Discovery>('/api/uptime/mcp/discover', {
          method: 'POST', body: { url: url.trim(), ...(auth && token ? { token } : {}) },
        });
        setDiscovery(result);
        setSelected(result.tools.filter((tool) => tool.readOnly && !tool.inputSchema.required?.length).map((tool) => tool.name));
        setArgs({}); setStep(2);
      } else {
        const tools = (discovery?.tools || []).filter((tool) => selected.includes(tool.name)).map((tool) => {
          let arguments_: unknown = {};
          try { arguments_ = JSON.parse(args[tool.name] || '{}'); }
          catch { throw new Error(`arguments:${tool.title || tool.name}`); }
          if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error(`arguments:${tool.title || tool.name}`);
          return { name: tool.name, arguments: arguments_, nameLabel: tool.title || tool.name };
        });
        await apiRequest('/api/uptime/mcp/import', {
          method: 'POST', body: { url: url.trim(), ...(auth && token ? { token } : {}), projectId: projectId || null, tools,
            ...(customNotify ? { channelIds } : {}) },
        });
        setToken(''); await onSaved(); onClose();
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : '';
      setError(detail === 'invalid-url' ? '请填写完整的 MCP 服务地址，例如 https://mcp.example.com/mcp。'
        : detail.startsWith('arguments:') ? `${detail.slice(10)}的调用参数须为有效 JSON 对象，请返回上一步修改。` : message(e));
    } finally { setBusy(false); onBusy(false); }
  };
  const selectedNames = channels.data?.channels.filter((channel) => channel.enabled && effectiveIds.includes(channel.id)
    && (channel.projects.length === 0 || channel.projects.includes(projectId))).map((channel) => channel.name) || [];
  return <>
    <div className="dh"><div className="dh-r"><Dialog.Title asChild><h2>接入我的服务</h2></Dialog.Title><span className="sp" />
      <Dialog.Close className="xb" aria-label="关闭" disabled={busy}><X className="ic" /></Dialog.Close></div>
      <Dialog.Description className="hint">公共基础设施服务已默认在监控中。这里只需添加你自己的 MCP 服务，三步完成。</Dialog.Description>
      <div className="steps">{['粘贴地址', '确认监控项', '通知并完成'].map((label, index) => <div key={label}
        className={`step${step === index + 1 ? ' on' : step > index + 1 ? ' done' : ''}`} aria-current={step === index + 1 ? 'step' : undefined}>
        <i /><span>{index + 1} · {label}</span></div>)}</div>
    </div>
    <div className="db" aria-busy={busy}>
      <ErrorNotice text={error} />
      {step === 1 && <>
        <div className="fld"><label htmlFor={`${id}-url`}>MCP 服务地址</label>
          <input id={`${id}-url`} className="inp code" type="url" placeholder="https://mcp.example.com/mcp" value={url}
            onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
          <p className="hint">粘贴服务的 Streamable HTTP 地址。我们会读取它公开的工具列表，自动生成可监控项，不需要安装任何探针。</p></div>
        <div className="recent">最近使用{recentUrl && recentHost
          ? <button type="button" className="chip tg" disabled={busy} onClick={() => setUrl(recentUrl)}>{recentHost}</button>
          : <span className="chip tg">暂无历史地址</span>}</div>
        <button type="button" className="adv" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
          <ChevronRight className="ic s" style={{ transform: advanced ? 'rotate(90deg)' : undefined }} />{advanced ? '收起高级设置' : '高级设置：鉴权（可选）'}</button>
        {advanced && <div className="advb"><div className="fld"><span className="lbl2">鉴权方式</span><div className="seg">
          <button type="button" className={!auth ? 'on' : ''} onClick={() => setAuth(false)}>无需鉴权</button>
          <button type="button" className={auth ? 'on' : ''} onClick={() => setAuth(true)}>Bearer Token</button></div></div>
          {auth && <div className="fld"><label htmlFor={`${id}-token`}>访问令牌</label><input id={`${id}-token`} className="inp code" type="password"
            autoComplete="new-password" placeholder="粘贴访问令牌" value={token} onChange={(event) => setToken(event.target.value)} /></div>}
          <p className="hint">凭据仅用于访问此服务，保存后不会回显。</p></div>}
        <div className="soft"><b>接入后会发生什么</b><ol><li>读取真实工具列表，标出只读与写入类工具</li>
          <li>确认要追加的只读监控项，并补充必要的调用参数</li><li>选择通知通道，开始按计划获取真实观测结果</li></ol></div>
      </>}
      {step === 2 && discovery && <>
        <div className="disc-h"><span className="t">{discovery.server.name}<span className="tag">MCP · {discovery.tools.length} 个工具</span></span>
          <p className="hint">已勾选无需参数的只读工具。写入类或未声明只读的工具不自动调用。</p></div>
        <div className="disc">{discovery.tools.map((tool) => <div key={tool.name}>
          <label className={`di${selected.includes(tool.name) ? ' on' : ''}${!tool.readOnly ? ' ex' : ''}`}>
            <input type="checkbox" checked={selected.includes(tool.name)} disabled={!tool.readOnly}
              onChange={() => setSelected((value) => value.includes(tool.name) ? value.filter((name) => name !== tool.name) : [...value, tool.name])} />
            <span className="di-b"><span className="di-n">{tool.title || tool.name}<span className="tool">{tool.name}</span></span>
              <span className="hint">{tool.description || tool.reason || '此工具尚未提供说明'}</span></span>
            <span className="tag">{tool.readOnly ? '只读' : '不调用'}</span>
          </label>
          {selected.includes(tool.name) && (tool.inputSchema.required?.length || Object.keys(tool.inputSchema.properties || {}).length > 0) ? <div className="tool-arguments fld">
            <label htmlFor={`${id}-${tool.name}`}>调用参数（JSON）{tool.inputSchema.required?.length ? ` · 必填：${tool.inputSchema.required.join('、')}` : ' · 可选'}</label>
            <textarea id={`${id}-${tool.name}`} className="inp code" rows={3} value={args[tool.name] || '{}'} spellCheck={false}
              onChange={(event) => setArgs((value) => ({ ...value, [tool.name]: event.target.value }))} />
          </div> : null}
        </div>)}</div>
        {!discovery.tools.length && <div className="soft">这个服务没有公开工具，暂时没有可追加的监控项。</div>}
        <div className="fld"><label htmlFor={`${id}-category`}>加入分类</label><select id={`${id}-category`} className="inp" value={projectId}
          onChange={(event) => setProjectId(event.target.value)}><option value="">我的服务</option>{projects.map(([project, name]) => <option key={project} value={project}>{name}</option>)}</select>
          <p className="hint">新监控项追加在分类中，其他分类的顺序保持不变。</p></div>
      </>}
      {step === 3 && <>
        {channels.loading ? <ContentLoading label="读取通知通道" variant="rows" /> : channels.error ? <>
          <ErrorNotice text={channels.error} /><button type="button" className="btn ghost" onClick={() => void channels.reload()}>重试读取通知通道</button>
        </> : channels.data && <ChannelFields data={channels.data} selected={effectiveIds} onToggle={toggleChannel} onManage={onManage} projectId={projectId || null} />}
        <div className="soft"><b>{selected.length} 项监控等待接入</b><p className="hint">{!customNotify ? '沿用全局默认通知设置。' : selectedNames.length
          ? `异常时通知到 ${selectedNames.join('、')}。` : '没有选择通道，新接入的监控不发送通知。'}设置通知不会发送测试消息。</p>
          {customNotify && <button type="button" className="linkb" onClick={() => setCustomNotify(false)}>恢复全局默认</button>}</div>
        <div className="sentence">完成后按计划调用所选只读工具获取真实结果；首次检查完成前显示“等待首次观测”，不会提前标为正常。</div>
      </>}
      {busy && <ContentLoading label={step === 1 ? '正在连接服务并读取工具列表' : '正在保存监控与通知设置'} variant="rows" />}
    </div>
    <div className="df">{step > 1 && <button type="button" className="btn ghost" disabled={busy} onClick={() => { setError(null); setStep(step - 1); }}>上一步</button>}
      <span className="sp" /><button type="button" className="btn ghost" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn pri" disabled={busy || (step === 1 ? !url.trim() || (auth && !token.trim()) : selected.length === 0)}
        onClick={() => void advance()}>{busy ? step === 1 ? '正在发现服务…' : '正在接入…' : step === 1 ? '发现服务' : step === 2 ? `追加 ${selected.length} 项，下一步` : '完成接入'}</button></div>
  </>;
}

function NotificationDrawer({ targets, targetId, onClose, onSaved, onBusy, onManage }: DrawerBodyProps): JSX.Element {
  const channels = useChannels();
  const [serviceId, setServiceId] = useState(targetId);
  const [scope, setScope] = useState<'default' | 'service'>(targetId ? 'service' : 'default');
  const [own, setOwn] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = targets.find((item) => item.id === serviceId);
  const defaults = channels.data?.settings.defaultChannelIds ?? channels.data?.channels.filter((channel) => channel.enabled).map((channel) => channel.id) ?? [];
  const override = serviceId ? channels.data?.settings.overrides?.[serviceId] : undefined;
  useEffect(() => {
    if (!channels.data) return;
    setOwn(scope === 'service' && override !== undefined);
    setDirty(false);
    setSelected(scope === 'service' ? override ?? channels.data.settings.defaultChannelIds
      ?? channels.data.channels.filter((channel) => channel.enabled).map((channel) => channel.id)
      : channels.data.settings.defaultChannelIds ?? channels.data.channels.filter((channel) => channel.enabled).map((channel) => channel.id));
  }, [channels.data, scope, override]);
  const applicableChannels = channels.data?.channels.filter((channel) => channel.enabled && (scope === 'default'
    || channel.projects.length === 0 || channel.projects.includes(target?.projectId || ''))) || [];
  const names = applicableChannels.filter((channel) => selected.includes(channel.id)).map((channel) => channel.name);
  const toggle = (channelId: string): void => {
    setSelected((value) => value.includes(channelId) ? value.filter((id) => id !== channelId) : [...value, channelId]);
    setDirty(true);
  };
  const save = async (reset = false): Promise<void> => {
    setBusy(true); onBusy(true); setError(null);
    try {
      await apiRequest('/api/uptime/notifications', { method: 'PUT', body: scope === 'default'
        ? { defaultChannelIds: selected } : { targetId: serviceId, channelIds: reset ? null : selected } });
      await onSaved(); onClose();
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); onBusy(false); }
  };
  return <>
    <div className="dh"><div className="dh-r"><Dialog.Title asChild><h2>{scope === 'service' ? '通知设置 · 此服务' : '通知设置'}</h2></Dialog.Title>
      <span className="sp" /><Dialog.Close className="xb" aria-label="关闭" disabled={busy}><X className="ic" /></Dialog.Close></div>
      <Dialog.Description className="hint">{scope === 'service' ? `${target?.name || '当前服务'} · 单项设置优先于全局默认。` : '设置所有服务的默认通知对象与渠道，单项服务可单独调整。'}</Dialog.Description>
      <div className="seg scope-seg" role="group" aria-label="设置范围"><button type="button" className={scope === 'default' ? 'on' : ''} disabled={busy}
        onClick={() => setScope('default')}>全局默认</button>{serviceId && <button type="button" className={scope === 'service' ? 'on' : ''}
          disabled={busy} onClick={() => setScope('service')}>此服务</button>}</div>
    </div>
    <div className="db" aria-busy={busy}>
      <ErrorNotice text={error || channels.error} />
      {channels.loading ? <ContentLoading label="读取通知设置" variant="panel" /> : !channels.data ? <button type="button" className="btn ghost" onClick={() => void channels.reload()}>重试读取通知设置</button> : <>
        {scope === 'service' && !own ? <div className="inh"><b>沿用全局默认通知</b><dl className="kv"><dt>通知谁</dt>
          <dd>{applicableChannels.filter((channel) => defaults.includes(channel.id)).map((channel) => channel.name).join('、') || '暂无适用于此服务的默认通知通道'}</dd>
          <dt>规则</dt><dd>业务新异常保留 30 分钟冷却，连续健康 10 分钟后通知恢复；按通道订阅的事件发送</dd></dl>
          <button type="button" className="btn pri sm" onClick={() => { setOwn(true); setDirty(true); }}>为此服务单独设置</button></div> : <>
          <ChannelFields data={channels.data} selected={selected} onToggle={toggle} onManage={onManage}
            projectId={scope === 'service' ? target?.projectId || null : undefined} />
          <DeliveryRule channels={applicableChannels} selected={selected} />
          <div className="sentence">{names.length ? `异常时通知到 ${names.join('、')}。` : '当前没有选择通知通道，本范围内的监控将不发送通知。'}{scope === 'service' ? '仅应用于此服务。' : '应用于没有单项覆盖的服务。'}</div>
        </>}
        {scope === 'default' && <>
          <div className="fld"><div className="sec-h"><span className="lbl2">分类默认</span><span className="hint">各分类沿用全局默认</span></div>
            <div className="soft"><p className="hint">已配置通道仍按项目及事件范围投递，服务单项设置优先。</p></div></div>
          <div className="fld"><div className="sec-h"><span className="lbl2">单项服务调整</span><span className="hint">在服务详情中调整通知</span></div>
            <div className="ovl">{Object.entries(channels.data.settings.overrides || {}).map(([itemId, ids]) => <div className="ovr" key={itemId}>
              <span className="nm">{targets.find((item) => item.id === itemId)?.name || '已移除的服务'}</span><span className="dest">
                {channels.data?.channels.filter((channel) => ids.includes(channel.id)).map((channel) => channel.name).join('、') || '不发送通知'}</span>
              <button type="button" className="linkb" onClick={() => { setServiceId(itemId); setScope('service'); }}>查看</button></div>)}</div>
            {!Object.keys(channels.data.settings.overrides || {}).length && <p className="hint">暂无单项覆盖，所有服务沿用默认。</p>}
          </div>
        </>}
      </>}
      {busy && <ContentLoading label="正在保存通知设置" variant="inline" />}
    </div>
    <div className="df">{scope === 'service' && own && <button type="button" className="btn ghost" disabled={busy}
      onClick={() => void save(true)}>恢复为默认</button>}<span className="sp" />
      <button type="button" className="btn pri" disabled={busy || channels.loading || !channels.data}
        onClick={() => { if (!dirty || (scope === 'service' && !own)) onClose(); else void save(); }}>{busy ? '保存中…' : '保存并完成'}</button></div>
  </>;
}

export interface MonitorDrawersProps {
  panel: 'connect' | 'notify' | null;
  targetId?: string;
  targets: UptimeTargetSummary[];
  onClose(): void;
  onSaved(): Promise<void>;
  onManageNotifications?(): void;
}

/** 原设计抽屉，业务动作全部提交到真实监控与通知 API。 */
export function MonitorDrawers({ panel, targetId, targets, onClose, onSaved, onManageNotifications }: MonitorDrawersProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!panel) setBusy(false); }, [panel]);
  return <Dialog.Root open={panel !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><div className="monitor-drawers">
      <Dialog.Overlay className="scrim" />
      <Dialog.Content className="drawer" style={{ height: '100dvh', minHeight: 0 }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}>
        {panel === 'connect' ? <ConnectDrawer key="connect" targets={targets} onClose={onClose} onSaved={onSaved}
          onBusy={setBusy} onManage={onManageNotifications} /> : panel === 'notify' ? <NotificationDrawer key={targetId || 'default'}
          targets={targets} targetId={targetId} onClose={onClose} onSaved={onSaved} onBusy={setBusy} onManage={onManageNotifications} /> : null}
      </Dialog.Content>
    </div></Dialog.Portal>
  </Dialog.Root>;
}
