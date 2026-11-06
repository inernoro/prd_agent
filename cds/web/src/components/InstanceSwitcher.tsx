import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { instanceConsoleUrl, parseInstanceCatalog, type InstanceCatalog } from '../../../src/shared/instance-catalog';

const CACHE_KEY = 'cds:instance-addresses:v1';

function cachedCatalog(): InstanceCatalog | null {
  try { return parseInstanceCatalog(JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null')); }
  catch { return null; }
}

export function InstanceSwitcher({ above = false }: { above?: boolean }): JSX.Element {
  const [catalog, setCatalog] = useState(cachedCatalog);
  const [stale, setStale] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    apiRequest('/api/instance-catalog', { signal: controller.signal }).then(raw => {
      const next = parseInstanceCatalog(raw);
      if (cancelled) return;
      setCatalog(next);
      setStale(false);
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    }).catch(() => {
      if (!cancelled) setError('当前无法更新实例目录；已保存的地址仍可打开，服务状态需在目标确认。');
    }).finally(() => {
      window.clearTimeout(timer);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, []);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const current = catalog?.instances.find(instance => instance.url === origin);

  const download = (): void => {
    if (!catalog) return;
    // Plain text survives complete control-plane outages; contains no credentials.
    const text = ['CDS 主备入口（地址快照，非可用性证明）',
      ...catalog.instances.map(instance => `${instance.name}：${instanceConsoleUrl(instance)}`),
      '请在目标实例独立登录并选择已接入项目。不会迁移数据或接管原有流量。'].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cds-instance-addresses.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <details className="relative shrink-0 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border border-border px-2 py-1.5" aria-label="切换 CDS 实例">
        <Server className="h-4 w-4" aria-hidden />
        <span className="max-w-24 truncate">{current?.name || 'CDS 实例'}</span>
      </summary>
      <div className={`absolute right-0 z-50 w-72 max-w-[90vw] space-y-3 rounded-lg border border-border bg-background p-4 shadow-lg ${above ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
        <p className="font-medium">主备 CDS</p>
        <p className="break-all text-xs text-muted-foreground">当前：{typeof window !== 'undefined' ? window.location.host : '当前实例'}</p>
        {catalog?.instances.map(instance => (
          <a key={instance.id} href={instanceConsoleUrl(instance)} rel="noreferrer" aria-label={`${instance.name} · 打开控制台`} className="block rounded-md border border-border p-2 hover:bg-muted" aria-current={current?.id === instance.id ? 'page' : undefined}>
            <span className="font-medium">{instance.name}{current?.id === instance.id ? ' · 当前实例' : ' · 打开控制台'}</span>
            <span className="block break-all text-xs text-muted-foreground">{instance.url}</span>
          </a>
        ))}
        {loading && !catalog?.instances.length && <ContentLoading label="读取主备 CDS 目录" />}
        {!loading && !error && !catalog?.instances.length && <p className="text-muted-foreground">请在仓库根目录 cds-instances.json 登记主备地址。</p>}
        <p className="text-xs text-muted-foreground">目标实例需独立登录并接入项目。切换不会迁移数据库，也不会接管原有部署流量。</p>
        {error && <p role="status" className="text-xs text-muted-foreground">{error}</p>}
        {stale && catalog && <p className="text-xs text-muted-foreground">显示本标签页保存的地址快照。</p>}
        <button type="button" disabled={!catalog?.instances.length} onClick={download} aria-label="下载备用入口" className="text-primary underline disabled:opacity-50">下载备用入口</button>
      </div>
    </details>
  );
}
