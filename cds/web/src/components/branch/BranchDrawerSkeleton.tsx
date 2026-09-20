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
 * 轮廓跟着总览的「指挥台」布局走（2026-09-18）：六块等高指标砖（3 列两行，极宽时 6 列）→ 关系行 → CPU 图 + 两块并排 → 服务表。不画部署历史：它在少于 3 次部署时本来就不出现，骨架里先画再消失比不画更假。
 */
import { MetricsSkeleton } from './OverviewPanel';
import { RelationCardSkeleton } from './RelationCard';
import { DRAWER_TAB_BUTTON_CLASS, DRAWER_TAB_NAV_CLASS, drawerTabs } from './drawerTabs';

/** 抽屉在这些状态下会在页签之上放一块「服务未运行」说明，骨架期照样给它留位 */
const STATUS_NOTE_STATES = new Set(['idle', 'stopped']);

const KPI_LABELS = ['状态', '服务就绪', '已运行', 'CPU 合计', '内存合计', '入口'] as const;
const ENV_SLOTS = ['共享基础设施', '复制集'] as const;

export function BranchDrawerSkeleton({ status }: { /** 父组件经 SSE 透传的实时状态，决定要不要给「服务未运行」说明留位 */ status?: string }): JSX.Element {
  const reserveStatusNote = status ? STATUS_NOTE_STATES.has(status) : false;
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label="加载分支详情" data-testid="branch-drawer-skeleton">
      {/* 页签之上的说明区：只有未运行 / 已停止的分支才有（与抽屉本体同一判据），否则一条空带都不留 */}
      {reserveStatusNote ? (
        <section className="border-b border-[hsl(var(--hairline))] px-5 py-4">
          <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2">
            <div className="cds-loading-skeleton-line h-3.5 w-20" />
            <div className="cds-loading-skeleton-line h-3 w-3/4" style={{ animationDelay: '0.1s' }} />
          </div>
        </section>
      ) : null}

      {/* 页签条：同一张表、同一套类名，只是不可点 */}
      <nav className={DRAWER_TAB_NAV_CLASS} aria-hidden>
        {drawerTabs.map((tab, i) => (
          <span key={tab.key} className={`${DRAWER_TAB_BUTTON_CLASS} ${i === 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
            {tab.label}
            {i === 0 ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
          </span>
        ))}
      </nav>

      <div className="flex flex-col gap-3 p-5">
        {/* 1. 六块指标砖：与 KpiTile 同一副外壳（标签 / 大数 / 副标题 + 走势位） */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {KPI_LABELS.map((label, i) => (
            <section key={label} className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-[1.3rem] py-4">
              <span className="text-[0.8125rem] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
              <div className="cds-loading-skeleton-line h-[2.2rem] w-2/3" style={{ animationDelay: `${i * 0.08}s` }} />
              <div className="flex min-h-[2.5rem] items-end"><div className="cds-loading-skeleton-line h-3.5 w-3/4" style={{ animationDelay: `${i * 0.08 + 0.1}s` }} /></div>
            </section>
          ))}
        </div>

        {/* 1.5 关系：与 RelationCard 的行式加载态是同一个组件 */}
        <RelationCardSkeleton variant="row" badge="等分支详情" note="分支详情到了就开始体检，通常 1 秒内完成" />

        {/* 3. 曲线：CPU 图满宽 + 下面两块并排，与总览出图前用的是同一个骨架 */}
        <div className="flex flex-col gap-3">
          <MetricsSkeleton filled={0} windowLabel="近 30 分钟" note="分支详情到了再读指标历史，曲线随之出现" />
          <div className="grid items-start gap-3 lg:grid-cols-[1.35fr_1fr]">
            {['内存占用', '吞吐'].map((t, i) => (
              <section key={t} className="flex flex-1 flex-col gap-3 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 pb-3 pt-3.5">
                <h4 className="text-base font-bold text-foreground">{t}</h4>
                <div className="cds-loading-skeleton-panel h-3.5 rounded-full" style={{ animationDelay: `${0.2 + i * 0.1}s` }} />
                <div className="cds-loading-skeleton-line h-3 w-1/2" style={{ animationDelay: `${0.3 + i * 0.1}s` }} />
              </section>
            ))}
          </div>
        </div>

        {/* 3.5 服务表：表头 + 两行 + 页脚（共享基础设施 / 复制集） */}
        <section className="rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-[1.3rem] pb-1 pt-1">
          <div className="grid h-9 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1.7fr)_minmax(0,1.6fr)] items-center gap-4 border-b border-[hsl(var(--hairline))] text-[0.75rem] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            <span>服务</span><span>状态</span><span>CPU</span><span>内存</span><span>容器</span>
          </div>
          {[0, 1].map((i) => (
            <div key={i} className="grid h-14 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1.7fr)_minmax(0,1.6fr)] items-center gap-4 border-b border-[hsl(var(--hairline))]/60 last:border-b-0">
              <div className="flex items-center gap-3"><div className="cds-loading-skeleton-panel h-[1.625rem] w-[1.625rem] rounded-[0.4rem]" /><div className="cds-loading-skeleton-line h-3.5 w-24" /></div>
              <div className="cds-loading-skeleton-line h-3.5 w-14" />
              <div className="cds-loading-skeleton-line h-1.5 w-full rounded-full" />
              <div className="cds-loading-skeleton-line h-1.5 w-full rounded-full" />
              <div className="cds-loading-skeleton-line h-3.5 w-28" />
            </div>
          ))}
          <div className="flex gap-6 border-t border-[hsl(var(--hairline))] py-2.5 text-[0.8125rem] text-muted-foreground">
            {ENV_SLOTS.map((label, i) => (
              <span key={label} className="flex items-center gap-2">{label}<div className="cds-loading-skeleton-line h-3 w-16" style={{ animationDelay: `${i * 0.1}s` }} /></span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
