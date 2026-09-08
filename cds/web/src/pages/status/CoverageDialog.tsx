/*
 * 覆盖面与判定手段：监控中心自己先回答两个问题——还有谁没被盯？盯的手段有多可信？
 *
 * 四档手段固定文案（它们描述的是探测器的实现，不是数据）；未纳入清单来自
 * summary.coverage（后端从同一份目标推导，不在前端另算一遍）。
 */
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { UptimeCoverage, UptimeProberHealth } from '@/lib/monitorCenter';

const METHODS: Array<{ title: string; verdict: string; tone: 'ok' | 'warn' | 'bad'; lines: string[] }> = [
  { title: '真实请求（生产 / 自定义）', verdict: '客观', tone: 'ok', lines: ['CDS 主机真的发 HTTP / TCP 请求，按规则判定', '单视角：CDS 主机出网，与用户路径可能不同', '计入「正常」与可用率'] },
  { title: '分支 · 进程视角', verdict: '半客观', tone: 'warn', lines: ['直连 127.0.0.1:宿主端口 根路径，状态码 < 500 即活', '证明进程在应答，不证明用户能打开预览域名', '计入「正常」，标注「进程视角」'] },
  { title: '分支 · 用户视角', verdict: '客观', tone: 'ok', lines: ['经预览域名走 forwarder / TLS / 路由，带探测头不触发降温', '与真人打开是同一条路', '5xx / 超时折进主判定；探测器够不着预览域名只标「暂不可用」，不算故障'] },
  { title: '按容器状态判定', verdict: '不是观测', tone: 'bad', lines: ['读 CDS 自己记录的 serviceStatus，是「以为在跑」', '不算「正常」，单列「未实测」', '可用率不计入，横幅不给绿'] },
];

const TONE_BAR: Record<'ok' | 'warn' | 'bad', string> = { ok: 'border-l-ok', warn: 'border-l-warn', bad: 'border-l-destructive' };
const TONE_TEXT: Record<'ok' | 'warn' | 'bad', string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-destructive' };

export function CoverageDialog({ open, onOpenChange, coverage, prober }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coverage: UptimeCoverage | undefined;
  prober: UptimeProberHealth | undefined;
}): JSX.Element {
  const uncovered = coverage?.uncovered ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame className="max-w-[1200px]" style={{ height: '82vh' }}>
        <header className="flex shrink-0 items-start gap-3 border-b border-[hsl(var(--hairline))] px-[18px] py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-lg font-semibold">覆盖面与判定手段</DialogTitle>
            <DialogDescription className="text-xs">监控中心自己先回答两个问题：还有谁没被盯？盯的手段有多可信？</DialogDescription>
          </div>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => onOpenChange(false)} aria-label="关闭">
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-[18px]" style={{ overscrollBehavior: 'contain' }}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {METHODS.map((m) => (
              <div key={m.title} className={cn('flex flex-col gap-2 rounded-lg border border-[hsl(var(--hairline))] border-l-4 bg-[hsl(var(--surface-raised))] px-3.5 py-3', TONE_BAR[m.tone])}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{m.title}</span>
                  <span className={cn('text-[11px] font-semibold', TONE_TEXT[m.tone])}>{m.verdict}</span>
                </div>
                {m.lines.map((l) => <span key={l} className="text-xs leading-[18px] text-muted-foreground">{l}</span>)}
              </div>
            ))}
          </div>
          {prober && !prober.userViewEnabled ? (
            <div className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">用户视角探测已按 CDS_UPTIME_USER_VIEW=0 关闭，分支目标目前只有进程视角。</div>
          ) : null}
          <div className="flex flex-col overflow-hidden rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
            <div className="flex flex-wrap items-center gap-3 bg-[hsl(var(--surface-sunken))] px-3.5 py-3">
              <span className="text-sm font-semibold">未纳入监控的对象</span>
              <span className="font-mono text-xs text-muted-foreground">{coverage ? `${coverage.uncovered.length} / ${coverage.total}` : '—'}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                范围：{coverage?.scope === 'trunk' ? '主干分支' : '全部分支'} + 生产目标 + 自定义（分支默认收起，主列表只展示主站）
              </span>
            </div>
            <div className="hidden grid-cols-[minmax(0,1.4fr)_140px_minmax(0,2fr)_180px] gap-3 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:grid">
              <span>对象</span><span>类型</span><span>为什么没盯</span><span>可以怎么做</span>
            </div>
            {uncovered.length === 0 ? (
              <div className="border-t border-[hsl(var(--hairline))] px-4 py-8 text-center text-sm text-muted-foreground">
                全部可监测对象都已纳入探测。
              </div>
            ) : uncovered.map((u) => (
              <div key={u.id} className="grid gap-1 border-t border-[hsl(var(--hairline))] px-3 py-2.5 text-[13px] md:grid-cols-[minmax(0,1.4fr)_140px_minmax(0,2fr)_180px] md:items-center md:gap-3">
                <span className="font-medium">{u.name}{u.projectName ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{u.projectName}</span> : null}</span>
                <span className="text-xs text-muted-foreground">{u.kind}</span>
                <span className="text-xs text-warn">{u.reason}</span>
                <span className="text-xs font-medium text-primary">{u.action}</span>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
