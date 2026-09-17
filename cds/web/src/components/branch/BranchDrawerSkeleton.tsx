/**
 * 分支详情抽屉的加载骨架——**总览的形状**，不是通用的横条。
 *
 * 2026-09-17 用户反馈：「页面加载的时候出现了两个骨架，一个是原来的老骨架，加载三秒之后
 * 出现了第二幅更接近现在真实的骨架」。病根是抽屉在等八个接口时画的是通用骨架（标题 + 四块
 * 指标 + 两块内容），数据到达后总览再按自己的轮廓（判断行 / 关系 / 入口 / 曲线）各画各的
 * 子骨架，两幅轮廓不一样，于是用户看见「换了一副」。
 *
 * 这里的部件与就绪期共用同一批实现：页签表（drawerTabs）、关系卡骨架（RelationCardSkeleton）、
 * 曲线骨架（MetricsSkeleton）。数据到了是每一块被「填上」，不是整屏「换掉」。
 *
 * 不画部署历史：它在少于 3 次部署时本来就不出现，骨架里先画再消失比不画更假。
 */
import { MetricsSkeleton } from './OverviewPanel';
import { RelationCardSkeleton } from './RelationCard';
import { DRAWER_TAB_BUTTON_CLASS, DRAWER_TAB_NAV_CLASS, drawerTabs } from './drawerTabs';

/** 抽屉在这些状态下会在页签之上放一块「服务未运行」说明，骨架期照样给它留位 */
const STATUS_NOTE_STATES = new Set(['idle', 'stopped']);

const ENV_SLOTS = ['复制集', '基础设施', '服务'] as const;

export function BranchDrawerSkeleton({ status }: { /** 父组件经 SSE 透传的实时状态，决定要不要给「服务未运行」说明留位 */ status?: string }): JSX.Element {
  const reserveStatusNote = status ? STATUS_NOTE_STATES.has(status) : false;
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="加载分支详情" data-testid="branch-drawer-skeleton">
      {/* 页签之上的说明区：与抽屉本体同一个 section 外壳 */}
      <section className="border-b border-[hsl(var(--hairline))] px-5 py-4">
        {reserveStatusNote ? (
          <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
            <div className="cds-loading-skeleton-line h-3.5 w-20" />
            <div className="cds-loading-skeleton-line h-3 w-3/4" style={{ animationDelay: '0.1s' }} />
          </div>
        ) : <div />}
      </section>

      {/* 页签条：同一张表、同一套类名，只是不可点 */}
      <nav className={DRAWER_TAB_NAV_CLASS} aria-hidden>
        {drawerTabs.map((tab, i) => (
          <span key={tab.key} className={`${DRAWER_TAB_BUTTON_CLASS} ${i === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
            {tab.label}
            {i === 0 ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
          </span>
        ))}
      </nav>

      <div className="flex flex-col gap-4 p-5">
        {/* 1. 判断行：健康环 + 一句结论 + 版本行 */}
        <section className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-5 py-4">
          <div className="relative h-[8.25rem] w-[8.25rem] shrink-0" aria-hidden>
            <div className="absolute inset-[0.625rem] rounded-full border-[0.75rem] border-[hsl(var(--surface-sunken))] motion-safe:animate-pulse" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
              <div className="cds-loading-skeleton-line h-7 w-12" />
              <span className="text-[0.6875rem] text-muted-foreground">服务就绪</span>
            </div>
          </div>
          <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
              <div className="cds-loading-skeleton-line h-6 w-40" />
            </div>
            <div className="cds-loading-skeleton-line h-4 w-64 max-w-full" style={{ animationDelay: '0.1s' }} />
            <div className="cds-loading-skeleton-line h-3.5 w-80 max-w-full" style={{ animationDelay: '0.18s' }} />
          </div>
        </section>

        {/* 1.5 关系：与 RelationCard 的加载态是同一个组件 */}
        <RelationCardSkeleton badge="等分支详情" note="分支详情到了就开始体检，通常 1 秒内完成" />

        {/* 2. 入口：标题 + 一张主入口卡的轮廓 */}
        <section className="flex flex-col gap-2.5">
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="text-sm font-bold text-foreground">入口</h4>
            <div className="cds-loading-skeleton-line h-3.5 w-28" />
          </header>
          <div className="flex items-center gap-3 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3.5 py-3">
            <div className="cds-loading-skeleton-panel h-9 w-9 shrink-0 rounded-[0.625rem]" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="cds-loading-skeleton-line h-3.5 w-32" />
              <div className="cds-loading-skeleton-line h-3 w-72 max-w-full" style={{ animationDelay: '0.12s' }} />
            </div>
          </div>
        </section>

        {/* 3. 曲线：与总览出图前用的是同一个骨架 */}
        <MetricsSkeleton filled={0} windowLabel="近 30 分钟" note="分支详情到了再读指标历史，曲线随之出现" />

        {/* 5. 部署环境 */}
        <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
          {ENV_SLOTS.map((label, i) => (
            <span key={label} className="contents">
              {i > 0 ? <span className="h-7 w-px bg-[hsl(var(--hairline))]" aria-hidden /> : null}
              <span className="flex flex-col gap-1">
                <span className="text-[0.625rem] font-bold uppercase tracking-[0.09em] text-muted-foreground">{label}</span>
                <div className="cds-loading-skeleton-line h-3.5 w-24" style={{ animationDelay: `${i * 0.1}s` }} />
              </span>
            </span>
          ))}
        </section>
      </div>
    </div>
  );
}
