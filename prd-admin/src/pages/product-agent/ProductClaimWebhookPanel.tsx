import { useEffect, useRef, useState } from 'react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getClaimWebhook, saveClaimWebhook, getClaimNotices, resendClaimNotice, type ClaimWebhookConfig, type ClaimNoticeRow } from '@/services/real/productClaimWebhook';

const STATUS: Record<string, { label: string; description?: string; poll?: boolean }> = {
  pending: { label: '待发送', description: '通知已入队，尚未收到后台的发送结果；后台暂未提供具体等待原因。无需重新申领版本号。', poll: true },
  debug_pending: { label: '待手工推送', description: '该通知需手工推送，请点击本条“补发”。关闭调试模式不会自动补发。', poll: true },
  sending: { label: '发送中', description: '后台正在投递通知，请稍候，无需重复申领版本号。', poll: true },
  sent: { label: '已发送' },
  blocked: { label: '未发送', description: '通知在发送前被拦截，但后台没有返回具体原因。请管理员检查版本申领通知任务日志。' },
  failed: { label: '未发送', description: '本次通知未发送成功，但后台没有返回具体原因。请管理员检查版本申领通知任务日志。' },
  unknown: { label: '结果待确认', description: '投递结果不确定，请先核对企微群消息，避免重复发送。' },
  waiting_identity: { label: '待发送', description: '通知仍在队列中，等待后台再次处理；后台暂未提供具体等待原因。无需重新申领版本号。', poll: true },
  cancelled: { label: '已取消' },
};
const UNKNOWN_STATUS = { label: '状态待确认', description: '后台返回的通知状态暂时无法识别，请刷新后联系管理员核对。' };

export function ProductClaimWebhookPanel() {
  const [config, setConfig] = useState<ClaimWebhookConfig | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dispatching = useRef(new Set<string>());
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  const [notices, setNotices] = useState<ClaimNoticeRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const hasPendingNotices = notices.some(row => STATUS[row.notification.status]?.poll === true);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await getClaimNotices();
      if (res.success) { setNotices(res.data.items); setRefreshError(''); }
      else setRefreshError(res.error.message);
    } catch {
      setRefreshError('暂时无法刷新通知状态，请稍后再试。');
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    let active = true;
    void getClaimWebhook().then(res => { if (active) { if (res.success) setConfig(res.data); else setMessage(res.error.message); } });
    void getClaimNotices().then(res => {
      if (!active) return;
      if (res.success) setNotices(res.data.items);
      else setRefreshError(res.error.message);
    }).catch(() => { if (active) setRefreshError('暂时无法读取通知状态，请点击“刷新状态”重试。'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!hasPendingNotices) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true;
      try {
        const res = await getClaimNotices();
        if (!active) return;
        if (res.success) { setNotices(res.data.items); setRefreshError(''); }
        else setRefreshError(res.error.message);
      } catch {
        if (active) setRefreshError('暂时无法刷新通知状态，请稍后再试。');
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [hasPendingNotices]);
  const resend = async (row: ClaimNoticeRow) => {
    const key = `${row.kind}:${row.id}`;
    if (dispatching.current.has(key)) return;
    dispatching.current.add(key); setSendingIds(new Set(dispatching.current)); setMessage('');
    try {
      const res = await resendClaimNotice(row.kind, row.id);
      setMessage(res.success && res.data.sent ? '通知已发送到企微群，无需重新申领。'
        : res.success ? '通知结果尚未确认，请刷新并核对群消息。' : res.error.message);
    } catch { setMessage('补发结果暂未确认，请先核对群消息并刷新状态，勿连续点击。'); }
    finally {
      await refresh();
      dispatching.current.delete(key); setSendingIds(new Set(dispatching.current));
    }
  };
  if (!config) return message ? <p role="alert">{message}</p> : <MapSectionLoader text="读取版本申领通知配置" />;
  const canEdit = config.canEdit ?? config.canSend;
  const save = async () => {
    setBusy(true); setMessage('');
    const res = await saveClaimWebhook({ enabled: config.enabled, debugMode: config.debugMode === true, notifyInternal: config.notifyInternal, notifyFormal: config.notifyFormal, url: url.trim() || undefined });
    setBusy(false);
    if (!res.success) { setMessage(res.error.message); return; }
    setUrl('');
    const current = await getClaimWebhook(); if (current.success) setConfig(current.data);
    setMessage('配置已保存。调试模式下先生成版本号，点击“调试通知”后才推送。');
  };
  return <section className="max-w-3xl space-y-5">
    <div><h3 className="text-sm font-semibold text-token-primary">版本申领通知</h3><p className="mt-2 text-xs leading-6 text-token-secondary">新申领 T/V 版本成功后自动推送，仅艾特表单所选的产品负责人。历史记录不会自动补发；仅点击单条“补发”时才发送该条通知。</p></div>
    {!canEdit && <p role="status" className="text-sm text-token-secondary">当前部署的 Webhook 配置为只读。</p>}
    {!config.canSend && <p role="status" className="text-sm text-token-secondary">
      {config.sendBlockedReason || '当前实例的后台通知任务未获授权，申领成功后不会自动推送。'} 请联系系统管理员检查部署授权。
    </p>}
    <fieldset disabled={busy || !canEdit} className="space-y-4 rounded-xl border border-token-subtle p-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} />启用版本申领通知</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.debugMode === true} onChange={e => setConfig({ ...config, debugMode: e.target.checked })} />调试模式（申领后手工推送）</label>
      <p className="text-xs leading-5 text-token-secondary">开启后先正常生成并显示版本号，再点击“调试通知”推送。关闭模式不会自动补发此前待手工推送的通知。</p>
      <div className="space-y-2"><p className="text-xs text-token-secondary">当前地址（脱敏）</p><code className="block break-all rounded-lg bg-token-nested p-3 text-xs">{config.maskedUrl || '尚未配置'}</code></div>
      <label className="block space-y-2 text-sm"><span>{config.configured ? '更换Webhook地址（留空保持不变）' : '企微群机器人Webhook地址'}</span><input type="password" autoComplete="new-password" value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴地址，保存后仅显示 Key 末 4 位" className="w-full min-w-0 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary" /></label>
      <div className="flex flex-wrap gap-5 text-sm"><label className="flex gap-2"><input type="checkbox" checked={config.notifyInternal} onChange={e => setConfig({ ...config, notifyInternal: e.target.checked })} />T版本立项</label><label className="flex gap-2"><input type="checkbox" checked={config.notifyFormal} onChange={e => setConfig({ ...config, notifyFormal: e.target.checked })} />V版本上线</label></div>
      <button type="button" onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg border border-token-subtle px-4 py-2 text-sm hover-bg-soft">{busy && <MapSpinner size={14} />}{busy ? '保存中…' : '保存配置'}</button>
    </fieldset>
    <div className="rounded-xl border border-token-subtle p-4 text-xs leading-6 text-token-secondary"><h4 className="font-medium text-token-primary">负责人身份自动复用</h4><p>直接使用所选MAP账号已验证的企微userid，缺少userid时使用已验证手机号；不用按姓名手填对应表。</p><p>已就绪 {config.identityReadyCount} 人，待自动同步 {config.identityPendingCount} 人。身份暂未同步也会正常发送通知；负责人再次通过企微登录后，后续通知自动使用该身份。</p></div>
    {message && <p role="status" className="text-sm text-token-secondary">{message}</p>}
    <div className="space-y-3 border-t border-token-subtle pt-4"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">最近版本申领通知</h4><button type="button" disabled={refreshing} className="inline-flex items-center gap-1 text-xs text-token-secondary" onClick={() => void refresh()}>{refreshing && <MapSpinner size={12} />}{refreshing ? '刷新中…' : '刷新状态'}</button></div>
      {hasPendingNotices && <p role="status" className="text-xs text-token-secondary">待处理通知每 5 秒自动刷新，刷新只更新状态，不会重复发送。</p>}
      {refreshError && <p role="alert" className="text-xs text-token-secondary">{refreshError}</p>}
      {notices.length === 0 && <p className="text-xs text-token-secondary">暂无新申领通知。</p>}
      {notices.map(row => <div key={`${row.kind}:${row.id}`} className="rounded-lg border border-token-subtle p-3 text-xs"><div className="flex flex-wrap items-center gap-3"><span>{row.code} · {row.ownerName}</span><span>{(STATUS[row.notification.status] ?? UNKNOWN_STATUS).label}</span>
        {config.canSend && ['pending', 'debug_pending', 'waiting_identity', 'failed'].includes(row.notification.status) && <button type="button"
          disabled={sendingIds.has(`${row.kind}:${row.id}`)}
          className="inline-flex items-center gap-1 rounded-lg border border-token-subtle px-3 py-1.5 disabled:opacity-50"
          onClick={() => void resend(row)}>{sendingIds.has(`${row.kind}:${row.id}`) ? <><MapSpinner size={12} />发送中…</> : '补发'}</button>}
      </div>{(row.notification.error || (STATUS[row.notification.status] ?? UNKNOWN_STATUS).description) && <p className="mt-2 leading-6 text-token-secondary">{row.notification.error || (STATUS[row.notification.status] ?? UNKNOWN_STATUS).description}</p>}</div>)}
    </div>
  </section>;
}
