import { useEffect, useState } from 'react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getClaimWebhook, saveClaimWebhook, getClaimNotices, retryClaimNotice, type ClaimWebhookConfig, type ClaimNoticeRow } from '@/services/real/productClaimWebhook';

const STATUS: Record<string, string> = { pending: '待发送', sending: '发送中', sent: '已发送', failed: '未发送', unknown: '结果待确认', waiting_identity: '待发送', cancelled: '已取消' };

export function ProductClaimWebhookPanel() {
  const [config, setConfig] = useState<ClaimWebhookConfig | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [notices, setNotices] = useState<ClaimNoticeRow[]>([]);
  const refresh = async () => { const res = await getClaimNotices(); if (res.success) setNotices(res.data.items); else setMessage(res.error.message); };
  useEffect(() => {
    let active = true;
    void getClaimWebhook().then(res => { if (active) { if (res.success) setConfig(res.data); else setMessage(res.error.message); } });
    void getClaimNotices().then(res => { if (active && res.success) setNotices(res.data.items); });
    return () => { active = false; };
  }, []);
  if (!config) return message ? <p role="alert">{message}</p> : <MapSectionLoader text="读取Webhook配置" />;
  const save = async () => {
    setBusy(true); setMessage('');
    const res = await saveClaimWebhook({ enabled: config.enabled, notifyInternal: config.notifyInternal, notifyFormal: config.notifyFormal, url: url.trim() || undefined });
    setBusy(false);
    if (!res.success) { setMessage(res.error.message); return; }
    setUrl('');
    const current = await getClaimWebhook(); if (current.success) setConfig(current.data);
    setMessage('配置已保存。只在新申领成功后自动推送，不发送测试群消息。');
  };
  return <section className="max-w-3xl space-y-5">
    <div><h3 className="text-sm font-semibold text-token-primary">申领通知 Webhook 配置</h3><p className="mt-2 text-xs leading-6 text-token-secondary">新T/V申领成功后发送完整通知，只艾特表单所选产品负责人，不艾特项目成员或所有人。历史记录不会补发。</p></div>
    {!config.canSend && <p role="status" className="text-sm text-token-secondary">当前环境只读配置，不发送群通知；请在正式环境保存。</p>}
    <fieldset disabled={busy || !config.canSend} className="space-y-4 rounded-xl border border-token-subtle p-4">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} />启用申领成功通知</label>
      <div className="space-y-2"><p className="text-xs text-token-secondary">当前地址（脱敏）</p><code className="block break-all rounded-lg bg-token-nested p-3 text-xs">{config.maskedUrl || '尚未配置'}</code></div>
      <label className="block space-y-2 text-sm"><span>{config.configured ? '更换Webhook地址（留空保持不变）' : '企微群机器人Webhook地址'}</span><input type="password" autoComplete="new-password" value={url} onChange={e => setUrl(e.target.value)} placeholder="粘贴地址，保存后不会回显密钥" className="w-full min-w-0 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary" /></label>
      <div className="flex flex-wrap gap-5 text-sm"><label className="flex gap-2"><input type="checkbox" checked={config.notifyInternal} onChange={e => setConfig({ ...config, notifyInternal: e.target.checked })} />T版本立项</label><label className="flex gap-2"><input type="checkbox" checked={config.notifyFormal} onChange={e => setConfig({ ...config, notifyFormal: e.target.checked })} />V版本上线</label></div>
      <button type="button" onClick={() => void save()} className="inline-flex items-center gap-2 rounded-lg border border-token-subtle px-4 py-2 text-sm hover-bg-soft">{busy && <MapSpinner size={14} />}{busy ? '保存中…' : '保存配置'}</button>
    </fieldset>
    <div className="rounded-xl border border-token-subtle p-4 text-xs leading-6 text-token-secondary"><h4 className="font-medium text-token-primary">负责人身份自动复用</h4><p>直接使用所选MAP账号已验证的企微userid，缺少userid时使用已验证手机号；不用按姓名手填对应表。</p><p>已就绪 {config.identityReadyCount} 人，待自动同步 {config.identityPendingCount} 人。身份暂未同步也会正常发送通知；负责人再次通过企微登录后，后续通知自动使用该身份。</p></div>
    {message && <p role="status" className="text-sm text-token-secondary">{message}</p>}
    <div className="space-y-3 border-t border-token-subtle pt-4"><div className="flex items-center justify-between"><h4 className="text-sm font-medium">最近申领通知</h4><button type="button" className="text-xs text-token-secondary" onClick={() => void refresh()}>刷新状态</button></div>
      {notices.length === 0 && <p className="text-xs text-token-secondary">暂无新申领通知。</p>}
      {notices.map(row => <div key={`${row.kind}:${row.id}`} className="rounded-lg border border-token-subtle p-3 text-xs"><div className="flex flex-wrap items-center gap-3"><span>{row.code} · {row.ownerName}</span><span>{STATUS[row.notification.status] ?? row.notification.status}</span>
        {row.notification.status === 'failed' && config.canSend && <button type="button" disabled={busy} className="underline" onClick={() => { setBusy(true); void retryClaimNotice(row.kind, row.id).then(res => { setBusy(false); setMessage(res.success ? '通知已重新排队，无需重复申领。' : res.error.message); if (res.success) void refresh(); }); }}>重试通知</button>}
      </div>{row.notification.error && <p className="mt-2 text-token-secondary">{row.notification.error}</p>}</div>)}
    </div>
  </section>;
}
