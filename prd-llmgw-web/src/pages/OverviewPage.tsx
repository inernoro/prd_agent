// 概览：网关控制台的「全面视图」入口（用户 2026-07-02：希望在 gw 看到全面的，而不是只有一个日志）。
// 一屏聚合：① 容器拓扑（每个容器的职责，治「多只脚」困惑）② 配置概览（平台/模型池/模型计数）
// ③ 影子比对摘要（剥离干净度信号）④ 快速入口。数据全部复用现有只读端点，无新增后端。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Server, GitCompare, ScrollText, Cpu, Layers, Database } from 'lucide-react';
import { getPools, getPlatforms, getModels, getShadowComparisons } from '@/lib/api';
import type { ModelPool, PlatformItem, ModelItem, ShadowSummary } from '@/lib/types';
import { Chip, SectionLoader } from '@/components/ui';

// 网关容器拓扑（SSOT：cds-compose.yml 的 services + .claude/rules/cds-dual-exit-topology.md）。
// 让用户一眼看懂「多只脚」：网关这套本就是 3 个独立容器（控制台后端 + serving 引擎 + 控制台前端），
// 加上 MAP 的 api/admin 与共享 mongo/redis，共 7 个容器，各司其职。
type TopoRole = {
  name: string;
  role: string;
  exposure: string;
  desc: string;
  group: 'gateway' | 'map' | 'infra';
};
const TOPOLOGY: TopoRole[] = [
  { name: 'llmgw-serve', role: 'serving 引擎', exposure: 'HTTPS 出口', desc: '独立可被调用的网关服务，/gw/v1/* 走 X-Gateway-Key 鉴权', group: 'gateway' },
  { name: 'llmgw', role: '控制台后端', exposure: 'HTTPS 出口', desc: '观测/管理后端（本控制台的 API），JWT 账号鉴权，读共享 Mongo', group: 'gateway' },
  { name: 'llmgw-web', role: '控制台前端', exposure: '经 llmgw 反代', desc: '你现在看的这个 SPA（nginx 托管，/gw/* 反代到 llmgw）', group: 'gateway' },
  { name: 'api', role: 'MAP 后端', exposure: 'HTTPS 出口', desc: 'PRD Agent 业务后端（LLM 调用方，Mode=http 时经 serving）', group: 'map' },
  { name: 'admin', role: 'MAP 前端', exposure: 'HTTPS 出口', desc: 'PRD Agent 管理后台 SPA', group: 'map' },
  { name: 'mongodb', role: '共享数据库', exposure: '内网', desc: '网关与 MAP 共享同一库（不分离），配置/日志/影子均落此', group: 'infra' },
  { name: 'redis', role: '共享缓存', exposure: '内网', desc: '网关与 MAP 共享缓存', group: 'infra' },
];

const GROUP_META: Record<TopoRole['group'], { label: string; color: string; bg: string; icon: JSX.Element }> = {
  gateway: { label: '网关', color: 'var(--accent)', bg: 'var(--accent-soft)', icon: <Cpu size={13} /> },
  map: { label: 'MAP 主应用', color: '#d29922', bg: 'rgba(210,153,34,0.14)', icon: <Layers size={13} /> },
  infra: { label: '共享基础设施', color: '#3fb950', bg: 'rgba(63,185,80,0.14)', icon: <Database size={13} /> },
};

export function OverviewPage() {
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [shadow, setShadow] = useState<ShadowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 每个 slice 失败也置空数组（而非留 null）→ loading 一定会收敛、不卡 spinner；成功的部分照常渲染局部数据。
    Promise.all([getPools(), getPlatforms(), getModels(), getShadowComparisons({ limit: 1 })]).then(
      ([poolsRes, platformsRes, modelsRes, shadowRes]) => {
        if (!alive) return;
        if (poolsRes.success) setPools(poolsRes.data.items); else { setPools([]); setError((e) => e || poolsRes.error?.message || '加载失败'); }
        if (platformsRes.success) setPlatforms(platformsRes.data.items); else { setPlatforms([]); setError((e) => e || platformsRes.error?.message || '加载失败'); }
        if (modelsRes.success) setModels(modelsRes.data.items); else { setModels([]); setError((e) => e || modelsRes.error?.message || '加载失败'); }
        if (shadowRes.success) setShadow(shadowRes.data.summary); else setShadow({ total: 0, allMatch: 0, critical: 0, httpFail: 0 });
      },
    ).catch((err) => {
      // Promise.all/then 里抛错也要收敛 loading（否则永远转圈）。
      if (!alive) return;
      setPools((p) => p ?? []); setPlatforms((p) => p ?? []); setModels((p) => p ?? []);
      setShadow((s) => s ?? { total: 0, allMatch: 0, critical: 0, httpFail: 0 });
      setError((e) => e || (err instanceof Error ? err.message : '加载失败'));
    });
    return () => { alive = false; };
  }, []);

  const loading = pools === null || platforms === null || models === null;
  // 完全没加载出来（都还 null）时才整屏报错/转圈；有部分数据则进入下方渲染，用顶部横幅提示失败（不掩盖故障）。
  if (loading && error) return <Empty text={error} />;
  if (loading) return <SectionLoader text="正在加载网关概览…" />;

  const enabledPlatforms = platforms!.filter((p) => p.enabled).length;
  const defaultPools = pools!.filter((p) => p.isDefaultForType).length;
  const enabledModels = models!.filter((m) => m.enabled).length;
  const matchRate = shadow && shadow.total > 0 ? Math.round((shadow.allMatch / shadow.total) * 100) : null;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 部分接口失败：顶部横幅明示故障，避免「计数为 0」被误读为网关健康 */}
      {error ? (
        <div style={{ fontSize: 12, color: '#f85149', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(248,81,73,0.35)', background: 'rgba(248,81,73,0.08)' }}>
          部分配置接口加载失败（下方计数可能不完整）：{error}
        </div>
      ) : null}
      {/* 配置概览计数 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <StatCard icon={<Server size={16} />} label="平台" value={`${enabledPlatforms}/${platforms!.length}`} sub="启用/总数" to="/platforms" />
        <StatCard icon={<Boxes size={16} />} label="模型池" value={`${pools!.length}`} sub={`${defaultPools} 个默认池`} to="/pools" />
        <StatCard icon={<Cpu size={16} />} label="模型" value={`${enabledModels}/${models!.length}`} sub="启用/总数" to="/pools" />
        <StatCard
          icon={<GitCompare size={16} />}
          label="影子比对"
          value={shadow && shadow.total > 0 ? `${matchRate}%` : '暂无'}
          sub={shadow && shadow.total > 0 ? `${shadow.total} 样本 · ${shadow.critical} 严重差异` : '未开启 shadow 模式'}
          to="/shadow"
        />
      </div>

      {/* 容器拓扑 */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>容器拓扑</span>
          <Chip label={`${TOPOLOGY.length} 个容器`} color="var(--text-secondary)" bg="var(--bg-elevated)" />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          网关是 3 个独立容器（serving 引擎 + 控制台后端 + 控制台前端），与 MAP 的 api/admin、共享 mongo/redis 各司其职。
          这就是你在 CDS 面板看到「多只脚」的原因——不是异常，是剥离后的正常形态。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TOPOLOGY.map((t) => {
            const g = GROUP_META[t.group];
            return (
              <div
                key={t.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  background: 'var(--bg-elevated)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: g.color }}>{g.icon}<Chip label={g.label} color={g.color} bg={g.bg} /></span>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 120 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 84 }}>{t.role}</span>
                <Chip label={t.exposure} color={t.exposure.includes('HTTPS') ? '#3fb950' : 'var(--text-muted)'} bg={t.exposure.includes('HTTPS') ? 'rgba(63,185,80,0.14)' : 'var(--bg-surface)'} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 180 }}>{t.desc}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 快速入口 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <QuickLink to="/logs" icon={<ScrollText size={16} />} label="调用日志" desc="每次 LLM 请求的模型/耗时/传输通道" />
        <QuickLink to="/pools" icon={<Boxes size={16} />} label="模型池" desc="调度策略 + 池内模型健康" />
        <QuickLink to="/platforms" icon={<Server size={16} />} label="平台" desc="上游平台启用态 + 密钥状态" />
        <QuickLink to="/shadow" icon={<GitCompare size={16} />} label="影子比对" desc="inproc vs http 一致性证据" />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, to }: { icon: JSX.Element; label: string; value: string; sub: string; to: string }) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>{icon}{label}</span>
      <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>
    </Link>
  );
}

function QuickLink({ to, icon, label, desc }: { to: string; icon: JSX.Element; label: string; desc: string }) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{icon}{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</span>
    </Link>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
