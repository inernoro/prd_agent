// 调用全貌：点名这个模型之后会发生什么，用当前真实状态逐步回答。
//
// 为什么值得单开一屏：列表能告诉人「有几条线路」，告诉不了人「现在发一个请求会落到谁」。
// 而后者才是那份心安——尤其在「只给 appCallerCode、不点名模型」这条路上，调用方连自己
// 会用到哪个模型都不知道，这一屏是唯一能说清的地方。
//
// 判据全部来自服务端（CallTracePlanner，与运行时 GatewayRouteSelection 由行为对照测试钉死）。
// 这个组件不做任何「哪条是主」的判断——前端曾经自己算过一份，把「降级但仍在承接」的线路
// 显示成「没有主」，而运行时照样在用它。凡是结论性的句子都由后端下发，这里只负责排版。
import { useEffect, useState } from 'react';
import { getCallTrace } from '@/lib/api';
import type { CallTraceData } from '@/lib/types';
import { Chip, SectionLoader } from '@/components/ui';
import { CallTraceFlow } from '@/components/CallTraceFlow';
import { BODY_TEXT, HINT_TEXT, MONO_META } from '@/lib/typography';
import { CARD_BODY, GAP, INSET_BLOCK } from '@/lib/surface';

export function CallTracePanel({ logicalModelId }: { logicalModelId: string }) {
  const [data, setData] = useState<CallTraceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    getCallTrace(logicalModelId).then((res) => {
      if (!alive) return;
      if (res.success) setData(res.data);
      else setError(res.error?.message || '拉取调用全貌失败');
    });
    return () => { alive = false; };
  }, [logicalModelId]);

  if (error) return <div style={{ ...INSET_BLOCK, ...BODY_TEXT, color: 'var(--warn)' }}>{error}</div>;
  if (!data) return <SectionLoader text="正在推演这次调用会怎么走…" />;

  const extraById = new Map(data.routeExtras.map((x) => [x.offeringId, x]));
  const eligible = data.routes.filter((x) => !x.skipReason);
  const weighted = data.routingStrategy === 'weighted';

  return (
    <div data-testid="call-trace-panel" style={{ display: 'flex', flexDirection: 'column', gap: GAP.section }}>

      {/* 结论在最前面。把一屏数字丢给人自己算「所以会落到谁」，这一屏就白做了。 */}
      <div data-testid="call-trace-conclusion" style={{
        ...CARD_BODY,
        borderRadius: 'var(--radius)',
        border: `1px solid ${eligible.length === 0 ? 'var(--warn)' : 'var(--accent)'}`,
        background: eligible.length === 0 ? 'var(--warn-bg)' : 'var(--accent-soft)',
        display: 'flex', flexDirection: 'column', gap: GAP.tight,
      }}>
        <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>现在这一刻</span>
        <span style={{ ...BODY_TEXT, color: 'var(--text-primary)', fontWeight: 'var(--fw-strong)' as unknown as number }}>
          {data.conclusion}
        </span>
      </div>

      {/* 先给图，再给逐步细节。图回答「在哪一步会拐走」——这条链路的难点从来不是谁调用谁。
          每条岔路的状态由后端下发，这里只按状态上色。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
        <span style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-strong)' as unknown as number }}>
          这一刻，这条链路在它身上走成什么样
        </span>
        <CallTraceFlow nodes={data.flow} />
      </div>

      <Step index={1} title="调用方发一个请求">
        <p style={BODY_TEXT}>
          按用途发，形状统一。可以点名 <code style={MONO_META}>{data.publicId}</code>，也可以不点名。
        </p>
      </Step>

      {/* 「只给 appCallerCode 不点名」这条路必须单独占一格：它是调用方最常走、
          却最看不懂的一条——不点名的人根本不知道自己用到了哪个模型。

          这一格必须**逐个调用方**说，不能只说一句总结。2026-09-15 之前这里只有一句
          「会落到它 / 不会落到它」，而那句话没有主语：判据只看模型自己（是不是默认、
          启用了没、有没有能接的线路），全程不问谁在调。运行时对配了专属池的调用方
          整个跳过对外模型这一档，于是那句话对他们就是假的。 */}
      <Step index={2} title="只给 appCallerCode、不点名模型时" testId="call-trace-unnamed">
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
          {data.unnamed.reachingCallerCount > 0
            ? <Chip
                label={`${data.unnamed.reachingCallerCount}/${data.unnamed.callerCount} 个调用方会落到它`}
                color="var(--ok)"
                bg="var(--ok-bg)"
              />
            : <Chip label="没有调用方会落到它" color="var(--text-muted)" bg="var(--bg-elevated)" />}
          <span style={{ ...BODY_TEXT, flex: 1, minWidth: 220 }}>{data.unnamed.summary}</span>
        </div>
        {data.unnamed.callers.length > 0 ? (
          <div
            data-testid="call-trace-unnamed-callers"
            style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight, paddingTop: GAP.tight }}
          >
            {data.unnamed.callers.map((caller) => (
              <div key={caller.appCallerCode} style={{
                ...INSET_BLOCK,
                display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap',
                border: `1px solid ${caller.reachesThisModel ? 'var(--accent)' : 'var(--border-subtle)'}`,
                opacity: caller.reachesThisModel ? 1 : 0.7,
              }}>
                <code style={{ ...MONO_META, flex: 1, minWidth: 200 }}>{caller.appCallerCode}</code>
                {caller.reachesThisModel
                  ? <Chip label="落到它" color="var(--ok)" bg="var(--ok-bg)" />
                  : caller.reach === 'TrafficRejected'
                    ? <Chip label="未放行" color="var(--warn)" bg="var(--warn-bg)" />
                    : <Chip label="不落到它" color="var(--text-muted)" bg="var(--bg-elevated)" />}
                <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', flex: 2, minWidth: 240 }}>
                  {caller.verdict}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', paddingTop: GAP.tight }}>
            这个用途下还没有登记任何调用方，所以现在没有人会不点名地落到它。
          </p>
        )}
      </Step>

      <Step index={3} title="过目录闸" testId="call-trace-gate">
        <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
          {data.gate.enabled
            ? <Chip label="已启用" color="var(--ok)" bg="var(--ok-bg)" />
            : <Chip label="已停用" color="var(--warn)" bg="var(--warn-bg)" />}
          <span style={{ ...BODY_TEXT, flex: 1, minWidth: 220 }}>{data.gate.summary}</span>
        </div>
        {data.gate.allowedAppCallerCodes.length > 0 ? (
          <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap', paddingTop: GAP.tight }}>
            {data.gate.allowedAppCallerCodes.map((code) => (
              <code key={code} style={{ ...MONO_META, padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)' }}>{code}</code>
            ))}
          </div>
        ) : null}
        {/* 说清这一屏**没有**推演什么，比假装推演全了要好。
            能力匹配是按每个调用方的场景判的，这里只列了授权名单。 */}
        <p style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', paddingTop: GAP.tight }}>
          这一格只看授权与启用。能力是否匹配要按具体调用方的场景判，没在这一屏推演——
          能力对不上会在解析时拒绝，理由写在请求记录里。
        </p>
      </Step>

      <Step
        index={4}
        title={weighted ? '挑一条：按权重分配' : '挑一条：按顺位'}
        testId="call-trace-routes"
      >
        <p style={HINT_TEXT}>
          {weighted
            ? '按权重分到各条线路。每次请求的落点由请求本身决定，所以这里只给比例，不指名道姓。'
            : '健康的排在降级的前面，然后按顺位。队首就是这次会落到的那一条。'}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.tight, paddingTop: GAP.tight }}>
          {data.routes.length === 0
            ? <span style={{ ...HINT_TEXT, color: 'var(--warn)' }}>一条线路都没有，现在调它一定失败。</span>
            : data.routes
              .slice()
              .sort((a, b) => (a.queuePosition || 999) - (b.queuePosition || 999))
              .map((route) => {
                const extra = extraById.get(route.id);
                const skipped = Boolean(route.skipReason);
                const head = !weighted && route.queuePosition === 1;
                return (
                  <div key={route.id} style={{
                    ...INSET_BLOCK,
                    display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap',
                    border: `1px solid ${head ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    opacity: skipped ? 0.65 : 1,
                  }}>
                    <span style={{ width: 62, flexShrink: 0, ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>
                      {skipped ? '不参与' : head ? '队首' : `第 ${route.queuePosition} 位`}
                    </span>
                    <span style={{ ...MONO_META, flex: 1, minWidth: 160 }}>
                      {route.providerName ? `${route.providerName} · ` : ''}{route.upstreamModelId || route.targetName}
                    </span>
                    <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)', width: 130, flexShrink: 0 }}>
                      顺位 {route.priority}{weighted ? ` · 权重 ${route.weight}` : ''}
                    </span>
                    {weighted && extra?.weightPercent != null && !skipped
                      ? <Chip label={`分到 ${extra.weightPercent}%`} color="var(--accent)" bg="var(--accent-soft)" />
                      : null}
                    <span style={{ width: 220, flexShrink: 0, ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>
                      {extra?.priceSummary || '单价未登记'}
                    </span>
                    {/* 半开候选要和「不参与」并排显示，不能只写进上面那句结论：
                        行里孤零零一个「不参与」会被读成「这条这次用不到」，而它恰恰可能被先试探。 */}
                    {skipped && extra?.halfOpenProbe ? (
                      <Chip label="可能先试探它" color="var(--accent)" bg="var(--accent-soft)" />
                    ) : null}
                    {skipped ? (
                      <Chip label={route.skipReason || '不参与'} color="var(--warn)" bg="var(--warn-bg)" />
                    ) : route.healthStatus === 1 ? (
                      <Chip label={`降级 · 连续失败 ${route.consecutiveFailures} 次`} color="var(--warn)" bg="var(--warn-bg)" />
                    ) : (
                      <Chip label="健康" color="var(--ok)" bg="var(--ok-bg)" />
                    )}
                  </div>
                );
              })}
        </div>
      </Step>

      <Step index={5} title="翻译成这家上游的方言">
        <p style={BODY_TEXT}>
          按线路所属上游的协议交给对应适配器。这是全链路唯一按上游分叉的地方，且分叉键是协议，不是模型名。
        </p>
        <div style={{ display: 'flex', gap: GAP.tight, flexWrap: 'wrap', paddingTop: GAP.tight }}>
          {[...new Set(data.routes.filter((x) => !x.skipReason).map((x) => x.protocol || ''))].map((protocol) => (
            <Chip
              key={protocol || 'inherit'}
              label={protocol ? `${protocol} 适配器` : '协议跟着目标模型走'}
              color="var(--text-secondary)"
              bg="var(--bg-elevated)"
            />
          ))}
        </div>
      </Step>

      <Step index={6} title={`记账 · 近 ${data.ledger.windowDays} 天`} testId="call-trace-ledger">
        <div style={{ display: 'flex', gap: GAP.section, flexWrap: 'wrap' }}>
          <Metric label="调用" value={data.ledger.calls.toLocaleString()} />
          <Metric label="花费" value={`$${Number(data.ledger.costUsd || 0).toFixed(4)}`} />
          <Metric
            label="未计价"
            value={`${data.ledger.unpricedCalls.toLocaleString()} 次`}
            warn={data.ledger.unpricedCalls > 0}
          />
          <Metric label="最近一次" value={data.ledger.lastCallAt ? data.ledger.lastCallAt.slice(0, 16).replace('T', ' ') : '从未'} />
        </div>
        {data.ledger.unpricedCalls > 0 ? (
          <p style={{ ...HINT_TEXT, paddingTop: GAP.tight }}>
            未计价的调用没有计入花费。把它们当零成本加进去会让这一屏看起来很省钱，所以单独计——去线路对应的上游模型补单价即可。
          </p>
        ) : null}
      </Step>

    </div>
  );
}

function Step({ index, title, children, testId }: {
  index: number;
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} style={{ display: 'flex', gap: GAP.section, alignItems: 'flex-start' }}>
      <span style={{
        width: 24, height: 24, flexShrink: 0, borderRadius: '50%',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-strong)' as unknown as number,
      }}>{index}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
        <span style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-strong)' as unknown as number }}>{title}</span>
        {children}
      </div>
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>{label}</span>
      <span className="tabular" style={{
        fontSize: 'var(--fs-metric)',
        fontWeight: 'var(--fw-strong)' as unknown as number,
        color: warn ? 'var(--warn)' : 'var(--text-primary)',
      }}>{value}</span>
    </div>
  );
}
