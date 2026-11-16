import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { apiRequest } from '@/lib/api';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { instanceConsoleUrl, parseInstanceCatalog, type InstanceCatalog } from '../../../src/shared/instance-catalog';

const CACHE_KEY = 'cds:instance-addresses:v1';
interface ClusterStatus {
  enabled: boolean;
  role?: 'authority' | 'member';
  state?: string;
  clusterId?: string;
  authorityUrl?: string;
  lastVerifiedAt?: string | null;
  members?: Array<{ nodeId: string; state: string }>;
}

function cachedCatalog(): InstanceCatalog | null {
  try { return parseInstanceCatalog(JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null')); }
  catch { return null; }
}

export function InstanceSwitcher({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const [catalog, setCatalog] = useState(cachedCatalog);
  const [stale, setStale] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [identity, setIdentity] = useState<ClusterStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    void apiRequest('/api/cluster/identity/status', { signal: controller.signal }).then(raw => {
      if (!cancelled) setIdentity(raw as ClusterStatus);
    }).catch(() => { if (!cancelled) setIdentity(null); });
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
      identity?.enabled ? '主备使用集群统一身份与授权。项目数据与部署流量仍按节点管理。'
        : '集群授权状态尚未确认，请联系系统所有者检查节点接入。'].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cds-instance-addresses.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <details className={`relative shrink-0 text-sm ${embedded ? 'w-full' : ''}`} onToggle={event => {
      if (event.currentTarget.open) void apiRequest('/api/cluster/identity/status').then(raw => setIdentity(raw as ClusterStatus)).catch(() => setIdentity(null));
    }}>
      <summary className={`flex cursor-pointer list-none items-center gap-1 rounded-md border border-border px-2 py-1.5 ${embedded ? 'ml-auto w-fit' : ''}`} aria-label="切换 CDS 实例">
        <Server className="h-4 w-4" aria-hidden />
        <span className="max-w-24 truncate">{current?.name || 'CDS 实例'}</span>
      </summary>
      <div className={`space-y-3 rounded-lg border border-border bg-background p-4 shadow-lg ${embedded ? 'mt-2 w-full' : 'absolute right-0 top-full z-50 mt-2 w-72 max-w-[90vw]'}`}>
        <p className="font-medium">主备 CDS</p>
        <p className="break-all text-xs text-muted-foreground">当前：{typeof window !== 'undefined' ? window.location.host : '当前实例'}</p>
        <p role="status" className="text-xs text-muted-foreground">{identity?.enabled
          ? identity.role === 'authority' ? '集群统一授权 · 主节点' : identity.state === 'synchronized' ? '集群统一授权 · 已同步' : '集群统一授权 · 等待核对'
          : '集群授权状态尚未确认'}</p>
        {catalog?.instances.map(instance => (
          <a key={instance.id} href={instanceConsoleUrl(instance)} rel="noreferrer" aria-label={`${instance.name} · 打开控制台`} className="block rounded-md border border-border p-2 hover:bg-muted" aria-current={current?.id === instance.id ? 'page' : undefined}>
            <span className="font-medium">{instance.name}{current?.id === instance.id ? ' · 当前实例' : ' · 打开控制台'}</span>
            <span className="block break-all text-xs text-muted-foreground">{instance.url}</span>
            {identity?.members?.find(member => member.nodeId === instance.id) && <span className="block text-xs text-muted-foreground">{
              identity.members.find(member => member.nodeId === instance.id)?.state === 'synchronized' ? '统一授权已核对' : '统一授权待核对'
            }</span>}
          </a>
        ))}
        {loading && !catalog?.instances.length && <ContentLoading label="读取主备 CDS 目录" />}
        {!loading && !error && !catalog?.instances.length && <p className="text-muted-foreground">请在仓库根目录 cds-instances.json 登记主备地址。</p>}
        <p className="text-xs text-muted-foreground">{identity?.enabled
          ? '主备共用身份与授权，权限变更及撤销由主节点统一生效。切换不迁移数据库或接管部署流量。'
          : '请由系统所有者完成集群接入并核对统一授权，再切换节点。'}</p>
        {error && <p role="status" className="text-xs text-muted-foreground">{error}</p>}
        {stale && catalog && <p className="text-xs text-muted-foreground">显示本标签页保存的地址快照。</p>}
        <button type="button" disabled={!catalog?.instances.length} onClick={download} aria-label="下载备用入口" className="text-primary underline disabled:opacity-50">下载备用入口</button>
      </div>
    </details>
  );
}
