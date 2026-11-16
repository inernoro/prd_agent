import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, RefreshCw } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { MapAgentSkillManifestDto } from '@/services/contracts/mcpConsole';
import { getMapAgentSkillManifestReal } from '@/services/real/mcpConsole';
import { toast } from '@/lib/toast';
import { safeArtifactHref } from './artifactHref';
import { copyToClipboard } from './clipboard';
import { buildSkillPrompt, CLIENT_REGISTRY, DEFAULT_CLIENT, type ClientKind, type SkillAction } from './clientRegistry';

export function useMapAgentSkillManifest() {
  const [manifest, setManifest] = useState<MapAgentSkillManifestDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getMapAgentSkillManifestReal();
      if (generation.current !== current) return;
      if (result.success && result.data) setManifest(result.data);
      else setError(result.error?.message || '技能版本没读到，请重试。');
    } catch {
      if (generation.current === current) setError('技能版本没读到，请检查网络后重试。');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  return { manifest, loading, error, reload };
}

export interface MapAgentSkillState {
  manifest: MapAgentSkillManifestDto | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const ACTIONS: Array<{ action: SkillAction; label: string }> = [
  { action: 'install', label: '复制安装指令' },
  { action: 'check', label: '复制版本检查' },
  { action: 'update', label: '复制更新指令' },
];

export function MapAgentSkillPanel({
  state,
  endpointUrl,
  clientKind,
}: {
  state: MapAgentSkillState;
  endpointUrl: string;
  clientKind?: ClientKind;
}) {
  const [selectedClient, setSelectedClient] = useState<ClientKind>(DEFAULT_CLIENT);
  const [copied, setCopied] = useState<string | null>(null);
  const client = clientKind ?? selectedClient;
  const downloadUrl = safeArtifactHref(client === 'workbuddy' ? state.manifest?.workBuddyDownloadUrl : state.manifest?.downloadUrl);
  const sha256 = client === 'workbuddy' ? state.manifest?.workBuddySha256 : state.manifest?.sha256;

  async function copyAction(action: SkillAction) {
    if (!state.manifest) return;
    try {
      if (await copyToClipboard(buildSkillPrompt(client, state.manifest, endpointUrl, action))) {
        setCopied(`${client}:${action}`);
        toast.success('指令已复制', '粘贴到对应客户端执行后查看实际结果。');
      } else toast.error('复制失败，请展开操作指令后手动复制');
    } catch {
      toast.error('连接地址不完整，请刷新接入台后重试');
    }
  }

  return (
    <section
      className="flex shrink-0 flex-col gap-2.5 rounded-[12px] px-3.5 py-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      aria-label="MAP 配套技能"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>MAP 配套技能</h3>
        {!clientKind ? (
          <label className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            客户端
            <select
              aria-label="技能安装客户端"
              value={selectedClient}
              onChange={(event) => { setSelectedClient(event.target.value as ClientKind); setCopied(null); }}
              className="rounded-[6px] px-1.5 py-1 text-[12px]"
              style={{ background: 'var(--bg-sunken)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            >
              {Object.entries(CLIENT_REGISTRY).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {state.loading ? (
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }} role="status">
          <MapSpinner size={14} /> 正在读取技能版本…
        </div>
      ) : null}
      {state.error ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px]" role="alert" style={{ color: 'var(--semantic-warning-text)' }}>
          <span>{state.error}</span>
          <button type="button" onClick={() => void state.reload()} className="underline">重试读取</button>
        </div>
      ) : null}
      {state.manifest ? (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            <span>服务发布版本 {state.manifest.version}</span>
            <button
              type="button"
              onClick={() => void state.reload()}
              disabled={state.loading}
              className="inline-flex items-center gap-1 underline disabled:opacity-60"
              aria-label="刷新技能发布版本"
            ><RefreshCw size={11} aria-hidden />刷新</button>
          </div>
          <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {CLIENT_REGISTRY[client].skillLocation} 网页无法读取本机已装版本，请在客户端执行版本检查。
          </p>
          <div className="flex flex-wrap gap-1.5">
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                className="inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-medium"
                style={{ background: 'var(--accent-primary-soft)', color: 'var(--accent-primary)', border: '1px solid var(--border-subtle)' }}
              ><Download size={12} aria-hidden />下载技能 ZIP</a>
            ) : null}
            {ACTIONS.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                onClick={() => void copyAction(action)}
                className="inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[11.5px] font-medium"
                style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              ><Copy size={12} aria-hidden />{copied === `${client}:${action}` ? `${label}已复制` : label}</button>
            ))}
          </div>
          <details className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <summary className="cursor-pointer">查看更新步骤与校验摘要</summary>
            <p className="mt-2 break-all">SHA-256：{sha256}</p>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed" style={{ fontFamily: 'ui-monospace, monospace' }}>
              {buildSkillPrompt(client, state.manifest, endpointUrl, 'update')}
            </pre>
          </details>
        </>
      ) : null}
    </section>
  );
}
