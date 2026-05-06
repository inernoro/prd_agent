/**
 * 基础设施服务管理（占位页 / WIP）
 *
 * 当前职责：仅作为入口占位，告知运营/开发"未来这里会管理共享 sidecar 服务实例"。
 * 真正的部署/编排能力规划迁移到 CDS（见 doc/plan.cds-shared-service-extension.md）。
 *
 * 主系统这一侧（本页面）的最终职责：
 *   - 实例只读列表（数据源 = CDS API + 主系统配置合并）
 *   - 路由策略（tag-weighted / sticky-by-runId / 加权）配置
 *   - 业务级监听（active runs / 平均延迟 / 错误率）
 *   - 「去 CDS 部署」深链跳转
 *
 * 不会做的事：SSH 部署 / docker compose 编排 / 容器健康探针（这些是 CDS 的事）。
 */
import { ExternalLink, Server, ShieldCheck, Wrench } from 'lucide-react';

const RESPONSIBILITY_SPLIT = [
  {
    side: 'CDS（部署 / 编排 / 健康 / 升级）',
    color: 'rgba(99,179,237,0.85)',
    items: [
      'RemoteHost 远程主机登记（SSH 凭据加密存储）',
      'shared-service Project 类型（绑定 git tag/release）',
      '部署引擎：SSH + docker compose pull / up',
      '健康监控 + docker logs 聚合',
      '蓝绿 / 滚动升级 / 回滚',
      '实例发现 API 供主系统消费',
    ],
  },
  {
    side: '本系统（路由 / 调度 / 业务监听）',
    color: 'rgba(167,243,208,0.85)',
    items: [
      'ClaudeSidecarRouter 多实例路由（tag/sticky/加权）',
      'DynamicSidecarRegistry 拉 CDS 实例发现 + 静态兜底',
      'profile / 上游切换（cc-switch / DeepSeek / Kimi 等）',
      '本页：实例只读列表 + 路由策略 + 业务级监控',
      'LlmRequestLogs 写入（已有）',
    ],
  },
];

const FUTURE_TABS = [
  { name: '实例', desc: '所有 sidecar 实例（来自 CDS + 静态配置合并），含状态/版本/region/uptime' },
  { name: '路由', desc: '配置 tag-weighted / sticky-by-runId / 加权策略，看每条 run 落到哪台' },
  { name: '监控', desc: 'active runs / p50/p99 延迟 / 错误率 / 上游分布（按 profile 聚合）' },
  { name: '配置', desc: 'profile yaml 编辑（DeepSeek / Kimi / cc-switch 等命名上游）' },
];

export default function InfraServicesPage() {
  return (
    <div
      className="flex flex-col gap-5 h-full min-h-0 overflow-y-auto"
      style={{ overscrollBehavior: 'contain', padding: '24px 28px' }}
    >
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-white">基础设施服务</h1>
          <p className="text-sm text-white/60 mt-1.5 max-w-2xl">
            管理 claude-sdk sidecar 等长生命周期共享服务的实例分布、路由策略与业务监控。
            部署 / 编排能力规划迁移到 CDS。
          </p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium"
          style={{
            background: 'rgba(245, 158, 11, 0.12)',
            color: 'rgba(252, 211, 77, 0.95)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
          }}
        >
          <Wrench size={12} /> 占位 / 未来迁至 CDS
        </span>
      </header>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(245, 158, 11, 0.06)',
          border: '1px solid rgba(245, 158, 11, 0.25)',
        }}
      >
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} style={{ color: 'rgba(252, 211, 77, 0.9)', marginTop: 2 }} />
          <div className="text-sm text-white/85 leading-relaxed">
            <strong className="text-white">这是一个隔离的占位入口。</strong>
            <br />
            部署 sidecar 到远程服务器、健康监控、滚动升级等能力将由 CDS 统一提供（参考
            <code className="mx-1 px-1 py-0.5 rounded bg-white/10 text-white/90">
              doc/plan.cds-shared-service-extension.md
            </code>
            ）。本页未来会接入 CDS 实例发现 API，提供路由策略与业务级监控。当前不要在此添加部署逻辑。
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {RESPONSIBILITY_SPLIT.map((block) => (
          <div
            key={block.side}
            className="rounded-xl p-5"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span
                className="w-1 h-4 rounded-sm"
                style={{ background: block.color }}
              />
              <h3 className="text-sm font-semibold text-white">{block.side}</h3>
            </div>
            <ul className="space-y-1.5 text-sm text-white/70">
              {block.items.map((it) => (
                <li key={it} className="flex gap-2">
                  <span className="text-white/30 select-none">·</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Server size={16} style={{ color: 'rgba(167, 243, 208, 0.9)' }} />
          <h3 className="text-sm font-semibold text-white">本页未来 4 个 tab</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {FUTURE_TABS.map((t) => (
            <div
              key={t.name}
              className="rounded-lg px-3.5 py-3"
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: '1px dashed rgba(255,255,255,0.08)',
              }}
            >
              <div className="text-sm font-medium text-white/85 mb-1">{t.name}</div>
              <div className="text-xs text-white/55 leading-relaxed">{t.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <h3 className="text-sm font-semibold text-white mb-3">相关文档</h3>
        <ul className="space-y-2 text-sm">
          <li>
            <a
              href="/doc/plan.cds-shared-service-extension.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              plan.cds-shared-service-extension.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">CDS 端扩展提案（待评审）</span>
          </li>
          <li>
            <a
              href="/doc/plan.sidecar-server-management.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              plan.sidecar-server-management.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">主系统自建方案（冻结备查）</span>
          </li>
          <li>
            <a
              href="/doc/design.claude-sdk-executor.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              design.claude-sdk-executor.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">claude-sdk 执行器架构</span>
          </li>
          <li>
            <a
              href="/doc/guide.claude-sdk-quickstart.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              guide.claude-sdk-quickstart.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">三步无脑配置 + 上游切换</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
