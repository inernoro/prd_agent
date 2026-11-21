import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api';
import type { DesignEntry, DesignShareHandoffReceipt, DesignSharePreparation, DesignVersion } from '../../../../src/shared/design-workspace';
import { designPath, type DesignCommand } from './design-ui';

const preparationTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export function DesignShareDialog({ entry, version, busy, command, close }: {
  entry: DesignEntry; version: DesignVersion; busy: boolean; command: DesignCommand; close: () => void;
}) {
  const [audience, setAudience] = useState<DesignSharePreparation['audience']>('password');
  const [hours, setHours] = useState('24');
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState('');
  const stop = useRef<() => void>();
  useEffect(() => () => stop.current?.(), []);
  const pending = (entry.sharePreparations ?? []).filter(row => row.version === version.version).reverse();

  async function proceed(preparation: DesignSharePreparation) {
    setStatus('');
    const popup = window.open('about:blank', '_blank', 'popup,width=820,height=700');
    if (!popup) { setStatus('窗口被浏览器拦截，请允许打开 MAP 确认页。'); return; }
    setOpening(true);
    const cancel = new AbortController();
    stop.current = () => { cancel.abort(); popup.close(); };
    try {
      const receipt = await apiRequest<DesignShareHandoffReceipt>(`${designPath(entry.projectId)}/shares/${encodeURIComponent(preparation.id)}/handoff`, {
        method: 'POST', body: { designId: entry.id }, signal: cancel.signal,
      });
      const destination = new URL(receipt.destination);
      if (receipt.preparationId !== preparation.id || !destination.pathname.endsWith('/web-pages/cds-share')
        || destination.search || destination.hash || !/^https?:$/.test(destination.protocol)) throw new Error('MAP 确认地址不可用');
      const release = () => {
        window.removeEventListener('message', ready);
        window.clearTimeout(timer);
        stop.current = undefined;
      };
      const ready = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== destination.origin || event.data?.type !== 'cds-design-share-ready') return;
        popup.postMessage({ type: 'cds-design-share', grant: receipt.grant }, destination.origin);
        release();
        setOpening(false);
        setStatus('请在 MAP 窗口核对版本并确认。');
      };
      const timer = window.setTimeout(() => {
        release(); popup.close(); setOpening(false); setStatus('MAP 确认窗口未就绪，请重新打开。');
      }, Math.max(0, Date.parse(receipt.expiresAt) - Date.now()));
      stop.current = () => { release(); popup.close(); };
      window.addEventListener('message', ready);
      popup.location.href = destination.href;
    } catch (error) {
      stop.current?.();
      stop.current = undefined;
      if (!cancel.signal.aborted || !popup.closed) popup.close();
      setOpening(false);
      if (error instanceof Error && error.name !== 'AbortError') setStatus(error.message);
    }
  }

  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="ep-dialog">
      <div className="ep-dialog-head"><DialogTitle>固定版本分享</DialogTitle>
        <DialogDescription>{version.title} · V{version.version} · {version.sourceCommit.slice(0, 12)}</DialogDescription></div>
      <form className="ep-dialog-form" onSubmit={event => {
        event.preventDefault();
        void command('share.prepare', { designId: entry.id, version: version.version, sourceCommit: version.sourceCommit,
          packageSha256: version.sha256, audience, expiresInHours: Number(hours) });
      }}>
        <div className="ep-dialog-content">
          <label className="ep-field">受众<select value={audience} onChange={event => setAudience(event.target.value === 'public' ? 'public' : 'password')}>
            <option value="password">凭密码访问</option><option value="public">获得链接的人</option></select></label>
          <label className="ep-field">有效小时数<input type="number" required min={1} max={8760} value={hours} onChange={event => setHours(event.target.value)} /></label>
          <p className="ep-caption">指定评审人需在 MAP 核对内容，确认后才会生成链接。</p>
          <div className="ep-row"><button type="submit" className="ep-button ep-button--primary" disabled={busy}>保存待确认记录</button></div>
        </div>
      </form>
      {!!pending.length && <section className="ep-dialog-content" aria-label="分享待确认记录">
        {pending.map(row => <div className="ep-row" key={row.id}>
          <span>{row.audience === 'public' ? '获得链接的人' : '凭密码访问'} · {row.expiresInHours} 小时
            {' · '}<time dateTime={row.preparedAt}>{preparationTime.format(new Date(row.preparedAt))}</time></span>
          <button type="button" className="ep-button" disabled={opening} onClick={() => void proceed(row)}>前往 MAP 确认</button>
        </div>)}
        {status && <p role="status" className="ep-caption">{status}</p>}
      </section>}
    </DialogContent>
  </Dialog>;
}
