/*
 * 通知通道（CDS 系统设置 → 接入）。
 *
 * 这一页存在的理由很具体：2026-09-14 按下监控面板的「演练一次通知」，结论是
 * **四个凭据一个都没配**——铃不是哑的，是根本不存在。而在这一页之前，想把它接上
 * 唯一的路是改宿主上的 `.cds.env`，于是「接铃」变成一件需要运维在场的事，
 * 而这条链最常见的失败恰恰就是根本没人去接。
 *
 * 页面只做三件事：说清现在通不通、让人把四个值填进去、填完当场演练一次。
 * 「填完就走」是不够的——没演练过的通道和没配的通道，在真出事那天是一样的。
 */
import { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCircle2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AlarmChannelsPanel } from '../AlarmChannelsPanel';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AlarmNotifyView {
  configured: boolean;
  source: 'settings' | 'env' | null;
  endpoint?: string;
  keyId?: string;
  username?: string;
  /** 指纹而不是私钥：够核对「配的是不是我给的那把」，又不构成泄漏面 */
  privateKeyFingerprint?: string;
  missingEnv?: string[];
}

const INPUT = 'w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary/50';

export function AlarmNotifyTab(): JSX.Element {
  const [view, setView] = useState<AlarmNotifyView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [form, setForm] = useState({ endpoint: '', keyId: '', username: '', privateKey: '' });

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await apiRequest<AlarmNotifyView>('/api/cds-system/alarm-notify'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await apiRequest('/api/cds-system/alarm-notify', { method: 'PUT', body: form });
      // 私钥只在这一次提交里出现，存完立刻从表单里抹掉——留在 DOM 里没有任何好处。
      setForm({ endpoint: '', keyId: '', username: '', privateKey: '' });
      setErr(null);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [form, load]);

  const runDrill = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setDrill(await apiRequest<{ ok: boolean; reason?: string }>('/api/uptime/alarm-drill', { method: 'POST', body: {} }));
    } catch (e) {
      setDrill({ ok: false, reason: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      await apiRequest('/api/cds-system/alarm-notify', { method: 'PUT', body: { clear: true } });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      {/* 多协议通道在前：它是现在该用的那条路。Bark 的 key 当场就能粘进来，
          不必先定「发给哪个 MAP 账号、用哪个 MAP 实例」那两件只有人能定的事。 */}
      <AlarmChannelsPanel />

      {/* 存量的单一 MAP 通道。先于多通道存在，且可能已经在工作——删掉它等于让已经
          接好的铃在升级那天哑掉，所以留着，只是降到第二位并说清它和上面的关系。 */}
      <div className="flex flex-col gap-4 border-t border-[hsl(var(--hairline))] pt-5">
      <div className="text-xs text-muted-foreground">
        下面这条是早先的单一 MAP 通道（走 .cds.env 或这一页的凭据）。它仍然工作；
        新配通道请用上面那一块，MAP 也在那里能选。
      </div>
      <div className={cn(
        'flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-3',
        view?.configured ? 'border-ok/30 bg-ok-soft/40' : 'border-destructive/40 bg-destructive/10',
      )}>
        <BellRing className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">
          {view?.configured
            ? `通知通道已配置（来自${view.source === 'settings' ? 'CDS 系统设置' : '.cds.env'}）`
            : '出问题时不会有任何人被通知'}
        </span>
        {view?.configured ? (
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {view.username} @ {view.endpoint} · 私钥指纹 {view.privateKeyFingerprint}
          </span>
        ) : (
          <span className="text-[0.6875rem] text-muted-foreground">
            监控探到故障时，告警只会留在 CDS 自己的台账里。填好下面四项即可接上。
          </span>
        )}
        <div className="flex-grow" />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void runDrill()}>
          {busy ? '处理中' : '演练一次通知'}
        </Button>
        {view?.configured && view.source === 'settings' ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>清除</Button>
        ) : null}
      </div>

      {drill ? (
        <div className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
          drill.ok ? 'border-ok/30 bg-ok-soft/40 text-ok' : 'border-destructive/40 bg-destructive/10 text-destructive')}>
          {drill.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {drill.ok ? '演练通知已送达 —— 这条链现在是通的' : `演练失败：${drill.reason || '原因不明'}`}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-4">
        <div className="text-xs text-muted-foreground">
          与 MAP 的签名通道对齐：MAP 侧只存公钥，私钥只留在 CDS、从不过网络。
          四项缺一即拒 —— 半套凭据只会在真出事那天以 401 的形式暴露。
        </div>
        {([
          ['endpoint', '通知端点', 'https://<你的 MAP>/api/dashboard/notifications/events'],
          ['keyId', '密钥 ID', '与 MAP 配置里那条的 KeyId 一致'],
          ['username', '通知账号', '与 MAP 配置里那条的 Username 一致，通知会发给这个账号'],
        ] as const).map(([key, label, ph]) => (
          <label key={key} className="flex flex-col gap-1">
            <span className="text-[0.6875rem] text-muted-foreground">{label}</span>
            <input className={INPUT} placeholder={ph} value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
          </label>
        ))}
        <label className="flex flex-col gap-1">
          <span className="text-[0.6875rem] text-muted-foreground">私钥（PKCS#8 PEM，只写不读）</span>
          <textarea
            className={cn(INPUT, 'h-28 font-mono')}
            placeholder={'-----BEGIN PRIVATE KEY-----\n...'}
            value={form.privateKey}
            onChange={(e) => setForm((f) => ({ ...f, privateKey: e.target.value }))}
          />
        </label>
        {err ? <div className="text-[0.6875rem] text-destructive">{err}</div> : null}
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save()}>保存并生效</Button>
          <span className="text-[0.6875rem] text-muted-foreground">
            保存后立刻生效，不需要重启 CDS；存完请紧接着演练一次 —— 没演练过的通道，和没配的通道在真出事那天是一样的。
          </span>
        </div>
      </div>
      </div>
    </div>
  );
}
