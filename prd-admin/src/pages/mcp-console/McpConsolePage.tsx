import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, KeyRound, Plug, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getMcpConsoleOverview } from '@/services';
import type { McpCapabilityDto, McpClientDto, McpConsoleOverviewDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { ConnectAgentDialog } from './ConnectAgentDialog';
import { McpCallsPanel } from './McpCallsPanel';
import { QuotaEditorDialog } from './QuotaEditorDialog';
import { copyToClipboard } from './clipboard';

/**
 * 智能体接入台。
 *
 * 一页回答三件事：我授权了什么、连着哪几台客户端、它们刚才做了什么。
 * 授权与配额都是服务端权威，这里只做展示与入口，不在前端复算。
 */
export default function McpConsolePage() {
  const [overview, setOverview] = useState<McpConsoleOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [tab, setTab] = useState<'overview' | 'calls'>('overview');
  const [quotaTarget, setQuotaTarget] = useState<McpClientDto | null>(null);
  // 「刷新」按钮只能刷自己拉的数据。调用记录面板自己管自己的分页与筛选，
  // 靠这个计数把刷新意图传下去 —— 否则用户停在记录页点刷新，列表纹丝不动。
  const [refreshToken, setRefreshToken] = useState(0);

  // 加载失败要留一个**持续存在**的错误态，不能只弹一下 toast 就放用户进正常页面 ——
  // overview 为 null 时正常页面会渲染成「0 个客户端、0 次调用、连接地址空白」，
  // 那和「账号是新的、什么都还没接」长得一模一样。toast 一消失，用户就以为接入台是空的，
  // 而实际上是它没读到数据（网络断了 / 没权限 / 服务端 500）。
  const [loadError, setLoadError] = useState<string | null>(null);
  // 手动刷新的 pending 只挂在按钮上。它**不能**是那个 loading ——
  // loading 会把整页换成 loader，而「连接新客户端」的弹窗就活在这一页里：
  // 发钥匙成功后弹窗回调父级刷新，整页一换，弹窗连带卸载，那把只出现一次的明文
  // 就跟着 state 一起没了，而钥匙已经在服务端生效了。
  const [refreshing, setRefreshing] = useState(false);

  // 代次令牌：顶部刷新还在飞的时候发一把新钥匙，onCreated 会再触发一次 load ——
  // 两次请求可以乱序回来，而先发的那次看到的还是「还没有这把钥匙」的世界。
  // 它后落地就会把新客户端与它的配额从界面上抹掉，用户刚发的钥匙一关弹窗就不见了。
  // 调用记录那一列上一轮已经用了同样的做法，这一处是同族里漏掉的兄弟。
  const loadGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    const res = await getMcpConsoleOverview();
    if (gen !== loadGenRef.current) return;   // 号过期：期间又发起了一次，丢弃这份旧结果
    if (!res.success || !res.data) {
      setLoadError(res.error?.message || '接入台数据没读到，可能是网络断开或服务端异常。');
      setLoading(false);
      return;
    }
    setLoadError(null);
    setOverview(res.data);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const onlineClients = useMemo(
    () => (overview?.clients ?? []).filter((c) => c.isActive).length,
    [overview],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <PrdLoader size={44} />
      </div>
    );
  }

  // 整页错误态只给首屏用：手里已经有数据时刷新失败，不该把用户正在看的东西抹掉。
  if (!overview) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          接入台数据没读到
        </div>
        <div className="max-w-[420px] text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          {loadError || '服务端没有返回数据。'}
          <br />
          这一屏显示的不是「你还没接入」，而是这次没读到 —— 已授权的客户端与调用记录都还在。
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium disabled:opacity-60"
          style={{
            background: 'var(--accent-primary)',
            color: 'var(--accent-on-solid)',
          }}
        >
          {refreshing ? '正在重试…' : '重试'}
        </button>
      </div>
    );
  }

  return (
    // 手机端不再自己加左右 padding：外层 gutter 由 AppShell 统一给（--mobile-padding，
    // ≤479px 8px / 其余 10px）。再叠一层 16px 的话，375 宽下外边距变成 24px，
    // 卡片自己的 padding 还要再吃一层——正是密度规则点名禁止的三层叠加。
    <div className="flex h-full min-h-0 flex-col gap-4 py-3 md:p-6">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <Plug size={19} style={{ color: 'var(--accent-primary)' }} aria-hidden />
            <h1 className="text-[19px] font-bold" style={{ color: 'var(--text-primary)' }}>
              智能体接入台
            </h1>
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-[11px] font-semibold"
              style={{
                background: 'var(--semantic-success-soft)',
                border: '1px solid var(--semantic-success-border)',
                color: 'var(--semantic-success-text)',
              }}
            >
              <span
                className="block h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--semantic-success-text)' }}
              />
              {onlineClients} 台客户端已授权
            </span>
          </div>
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            把这个平台接进你的智能体（Claude Code、Codex 等），它就能替你生图、写稿、整理知识库、把网页托管出来。
            今天它调用了 <b style={{ color: 'var(--text-primary)' }}>{overview?.today.calls ?? 0}</b> 次。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => {
              setRefreshToken((n) => n + 1);
              void refresh();
            }}
            className="flex h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] font-medium transition-colors"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            <RefreshCw size={15} aria-hidden className={refreshing ? 'animate-spin' : undefined} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
          <button
            type="button"
            onClick={() => setConnectOpen(true)}
            className="flex h-9 items-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: 'var(--accent-primary-solid)', color: 'var(--accent-on-primary)' }}
          >
            <Plus size={15} aria-hidden />
            连接新客户端
          </button>
        </div>
      </div>

      {loadError ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
          style={{
            background: 'var(--semantic-warning-soft)',
            border: '1px solid var(--semantic-warning-border)',
            color: 'var(--semantic-warning-text)',
          }}
        >
          <span>这次没刷上：{loadError} 下面显示的是上一次读到的数据。</span>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
            className="rounded-[7px] px-2.5 py-1 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
          >
            {refreshing ? '正在重试…' : '重试'}
          </button>
        </div>
      ) : null}

      {/* tab */}
      <div
        className="flex w-fit gap-1 rounded-[11px] p-1"
        style={{ background: 'var(--nested-block-bg)' }}
      >
        {([
          { key: 'overview' as const, label: '能力与客户端', icon: ShieldCheck },
          { key: 'calls' as const, label: '调用记录', icon: Activity },
        ]).map((item) => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className="flex items-center gap-2 rounded-[9px] px-3.5 py-1.5 text-[12.5px] font-medium transition-colors"
              style={
                active
                  ? { background: 'var(--bg-card)', color: 'var(--text-primary)' }
                  : { background: 'transparent', color: 'var(--text-muted)' }
              }
            >
              <Icon size={14} aria-hidden />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'calls' ? (
        <McpCallsPanel clients={overview?.clients ?? []} refreshToken={refreshToken} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* 能力清单：自己撑高自己滚，不把整页顶出去 */}
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                它能替我做什么
              </h2>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                没勾的能力，在智能体那边根本看不到
              </span>
            </div>
            <div className="flex flex-col gap-2.5">
              {(overview?.capabilities ?? []).map((cap) => (
                <CapabilityRow key={cap.key} capability={cap} />
              ))}
            </div>
          </div>

          {/* 右列 */}
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-0.5">
            <SectionCard title="连着的客户端" hint="一台一把钥匙">
              {(overview?.clients ?? []).length === 0 ? (
                <EmptyHint text="还没有客户端接进来。点右上角「连接新客户端」，两分钟就能连上。" />
              ) : (
                (overview?.clients ?? []).map((client) => (
                  <div
                    key={client.keyId}
                    className="flex items-center gap-2.5 rounded-[11px] px-3 py-2.5"
                    style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-faint)' }}
                  >
                    <span
                      className="block h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background: client.isActive
                          ? 'var(--semantic-success-text)'
                          : 'var(--text-disabled)',
                      }}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className="truncate text-[12.5px] font-semibold"
                        style={{ color: 'var(--text-primary)' }}
                      >
                        {client.name}
                      </span>
                      <span className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                        {client.keyPrefix}…
                        {client.lastUsedAt ? (
                          <>
                            {' · '}
                            <RelativeTime value={client.lastUsedAt} />
                            活跃
                          </>
                        ) : (
                          ' · 还没用过'
                        )}
                      </span>
                    </div>
                    <span
                      className="shrink-0 text-[12px] font-semibold tabular-nums"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {client.todayCalls}
                    </span>
                  </div>
                ))
              )}
            </SectionCard>

            <SectionCard title="今日额度" hint="按 UTC 自然日切">
              {(overview?.clients ?? []).length === 0 ? (
                <EmptyHint text="接入客户端后，这里会显示它今天用掉多少。" />
              ) : (
                (overview?.clients ?? []).map((client) => (
                  <div key={client.keyId} className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                        {client.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQuotaTarget(client)}
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--accent-primary)' }}
                      >
                        调整上限
                      </button>
                    </div>
                    <QuotaBar
                      label="生图"
                      used={client.todayImages}
                      quota={client.dailyImageQuota}
                      unit="张"
                    />
                    <QuotaBar
                      label="写入类动作"
                      used={client.todayWrites}
                      quota={client.dailyWriteQuota}
                      unit="次"
                    />
                  </div>
                ))
              )}
            </SectionCard>

            <SectionCard title="连接地址" hint="填进客户端的就是它">
              <code
                className="block break-all rounded-[9px] px-2.5 py-2 text-[11px]"
                style={{
                  background: 'var(--bg-sunken)',
                  border: '1px solid var(--border-faint)',
                  color: 'var(--text-secondary)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}
              >
                {overview?.endpointUrl ?? ''}
              </code>
              <button
                type="button"
                onClick={async () => {
                  if (!overview?.endpointUrl) return;
                  // 必须等它真的写进去：剪贴板不可用时报「已复制」，用户会拿一份旧内容
                  // 去粘贴进客户端配置，然后对着连不上的连接器排查半天。
                  if (await copyToClipboard(overview.endpointUrl)) toast.success('地址已复制');
                  else toast.error('复制失败，请手动选中上面的地址复制');
                }}
                className="flex h-8 items-center justify-center gap-1.5 rounded-[9px] text-[12px] font-medium"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                }}
              >
                <KeyRound size={13} aria-hidden />
                复制地址
              </button>
            </SectionCard>
          </div>
        </div>
      )}

      <QuotaEditorDialog
        client={quotaTarget}
        open={quotaTarget !== null}
        onOpenChange={(next) => {
          if (!next) setQuotaTarget(null);
        }}
        onSaved={() => void load()}
      />

      <ConnectAgentDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        capabilities={overview?.capabilities ?? []}
        endpointUrl={overview?.endpointUrl ?? ''}
        onCreated={() => void load()}
      />
    </div>
  );
}

function CapabilityRow({ capability }: { capability: McpCapabilityDto }) {
  const [expanded, setExpanded] = useState(false);
  const granted = capability.granted;
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[14px] px-4 py-3.5"
      style={{
        background: 'var(--bg-card)',
        border: granted ? '1px solid var(--border-subtle)' : '1px dashed var(--border-default)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {capability.title}
        </span>
        <span
          className="rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold"
          style={
            granted
              ? {
                  background: 'var(--semantic-success-soft)',
                  border: '1px solid var(--semantic-success-border)',
                  color: 'var(--semantic-success-text)',
                }
              : {
                  background: 'var(--nested-block-bg)',
                  border: '1px solid var(--border-faint)',
                  color: 'var(--text-muted)',
                }
          }
        >
          {granted ? `已授权 ${capability.tools.filter((t) => t.granted).length} 个工具` : '未授权'}
        </span>
        {!capability.availableToMe && (
          <span className="text-[11px]" style={{ color: 'var(--semantic-warning-text)' }}>
            你自己还没有这块权限，需要先找管理员开通
          </span>
        )}
        {capability.todayCalls > 0 && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            今天 {capability.todayCalls} 次
          </span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto text-[11.5px] font-medium"
          style={{ color: 'var(--accent-primary)' }}
        >
          {expanded ? '收起工具' : `看这 ${capability.tools.length} 个工具`}
        </button>
      </div>
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {capability.summary}
      </p>
      {expanded && (
        <div className="flex flex-col gap-1.5">
          {capability.tools.map((tool) => (
            <div
              key={tool.name}
              className="flex flex-wrap items-baseline gap-2 rounded-[9px] px-2.5 py-2"
              style={{ background: 'var(--bg-sunken)' }}
            >
              <code
                className="text-[11px]"
                style={{
                  color: tool.granted ? 'var(--text-primary)' : 'var(--text-disabled)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}
              >
                {tool.name}
              </code>
              {tool.isWrite && (
                <span
                  className="rounded-[5px] px-1.5 py-[1px] text-[10px]"
                  style={{
                    background: 'var(--semantic-orange-soft)',
                    border: '1px solid var(--semantic-orange-border)',
                    color: 'var(--semantic-warning-text)',
                  }}
                >
                  写入
                </span>
              )}
              <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {tool.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2.5 rounded-[14px] px-4 py-3.5"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </span>
        {hint && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function QuotaBar({
  label,
  used,
  quota,
  unit,
}: {
  label: string;
  used: number;
  quota: number;
  unit: string;
}) {
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </span>
        <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
          {used} / {quota} {unit}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full"
        style={{ background: 'var(--nested-block-bg)' }}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--accent-primary)' }}
        />
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
      {text}
    </p>
  );
}
