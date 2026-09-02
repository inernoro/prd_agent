/**
 * 「这个仓库还喂着别的项目」这件事在界面上的全部表达。
 *
 * ## 为什么值得单独一个文件
 *
 * 一个仓库绑上第二个项目之后，用户每一次操作都多出一个问题：**这会影响到谁**。
 * 这个问题会在三个地方冒出来（列表、项目设置、绑仓库那一刻），三处各写一遍
 * 必然漂移成「列表说两个、设置说三个」。所以判据在后端（repo-sharing.ts），
 * 表达集中在这里，页面只负责摆位置。
 *
 * ## 三档注意力，别一律拉满
 *
 * | 场合 | 强度 | 形态 |
 * |---|---|---|
 * | 正要把仓库绑给第二个项目 | 必须打断 | 确认弹窗，说清会发生什么 |
 * | 已经在这个项目里干活 | 必须显眼 | 页面顶部一条，带兄弟项目与范围提示 |
 * | 在列表里扫一眼 | 顺带告知 | 行内一行小字，点得进去 |
 *
 * 全部拉满等于全部无效：列表上二十个项目都顶一条黄条，用户第二天就看不见它们了。
 *
 * ## 显示关系，不显示标签
 *
 * 用户要的不是「本项目是多项目」这个状态词，而是「和谁关联、点得进去」。
 * 所以这里从头到尾展示的是兄弟项目本身，没有任何一枚写着「多项目」的徽章。
 */

import { Link } from 'react-router-dom';
import { GitBranch, Database, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface RepoSiblingRef {
  id: string;
  name: string;
  /** 该项目声明的构建范围并集；空 = 未声明 = 每次推送都会重建它 */
  scope: string[];
}

export interface SharedInfraHit {
  key: string;
  kind: 'database' | 'cache' | 'endpoint';
  projectIds: string[];
}

/** 后端 GET /api/projects[/:id] 的 repoSharing 字段。 */
export interface RepoSharing {
  total: number;
  unscoped: number;
  headline: string;
  level: 'ok' | 'warn';
  sharedInfra: SharedInfraHit[];
  siblings: RepoSiblingRef[];
  /**
   * 本项目还没划范围时系统给的建议。有它就别再让用户去空白框里想 ——
   * 直接说清「看起来只关心哪儿、凭什么这么说」，一下点掉。
   */
  scopeSuggestion?: { scope: string[]; why: string } | null;
}

function infraWhat(kind: SharedInfraHit['kind']): string {
  return kind === 'database' ? '同一个数据库' : kind === 'cache' ? '同一个缓存' : '同一个地址';
}

/**
 * 行内一行：同仓 · A、B。列表卡片用，不抢眼但点得进去。
 */
export function RepoSharingInline({
  sharing,
  selfId,
}: {
  sharing: RepoSharing | null | undefined;
  selfId: string;
}): JSX.Element | null {
  if (!sharing) return null;
  const others = sharing.siblings.filter((s) => s.id !== selfId);
  if (others.length === 0) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="shrink-0">同仓</span>
      <span className="min-w-0 truncate" title={others.map((o) => o.name).join('、')}>
        {others.map((o, i) => (
          <span key={o.id}>
            {i > 0 ? '、' : ''}
            <Link
              to={`/settings/${encodeURIComponent(o.id)}`}
              onClick={(e) => e.stopPropagation()}
              className="underline-offset-2 hover:underline"
            >
              {o.name}
            </Link>
          </span>
        ))}
      </span>
      {sharing.level === 'warn' ? (
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warn" aria-label="推送会重建未声明范围的项目" />
      ) : null}
    </div>
  );
}

/**
 * 页面顶部一条：结论 + 兄弟项目 + 真撞上的基础设施 + 一步就能去划范围。
 *
 * 最该引发关注的不是「有几个项目」，是**范围**：没划范围时任何一次推送都会把
 * 这些项目全部重建。所以警示语和那个按钮说的是同一件事，不要求用户自己联想。
 */
export function RepoSharingBanner({
  sharing,
  selfId,
  onDeclareScope,
  onApplySuggestion,
  applying = false,
}: {
  sharing: RepoSharing | null | undefined;
  selfId: string;
  onDeclareScope?: () => void;
  onApplySuggestion?: () => void;
  applying?: boolean;
}): JSX.Element | null {
  if (!sharing) return null;
  const others = sharing.siblings.filter((s) => s.id !== selfId);
  if (others.length === 0) return null;
  const warn = sharing.level === 'warn';
  const nameOf = (id: string): string => sharing.siblings.find((s) => s.id === id)?.name || id;
  // 「去划范围」只对**自己没划**的项目才是下一步。已经划好的项目仍要看见这条横幅
  // （它照样会被别人的推送连累），但让它去划一遍自己已经有的东西是句废话。
  const selfUnscoped = (sharing.siblings.find((s) => s.id === selfId)?.scope.length ?? 0) === 0;

  return (
    <div
      className={[
        'rounded-lg border px-4 py-3 text-sm',
        warn ? 'border-warn/40 bg-warn-soft' : 'border-border bg-muted/40',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5">
        {warn
          ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          : <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 flex-1 space-y-2">
          <p className="leading-relaxed">{sharing.headline}</p>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>同一个仓库还喂着：</span>
            {others.map((o) => (
              <Link
                key={o.id}
                to={`/settings/${encodeURIComponent(o.id)}`}
                className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:border-primary"
                title={o.scope.length > 0 ? `构建范围：${o.scope.join('、')}` : '未声明构建范围：任何推送都会重建它'}
              >
                {o.name}
                {o.scope.length === 0 ? <span className="ml-1 text-warn">未划范围</span> : null}
              </Link>
            ))}
          </div>

          {sharing.sharedInfra.length > 0 ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {sharing.sharedInfra.map((hit) => (
                <li key={`${hit.key}:${hit.projectIds.join(',')}`} className="flex items-start gap-1.5">
                  <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    {hit.projectIds.map(nameOf).join('、')} 的 <code className="font-mono">{hit.key}</code>
                    {' '}指向{infraWhat(hit.kind)} —— 一边写坏，另一边立刻可见。
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/*
           * 有建议就直接给建议，别把「去划范围」当作业布置给用户。系统看得出
           * 本项目只关心哪儿，也说得出凭什么，用户扫一眼依据就能决定点不点。
           */}
          {selfUnscoped && sharing.scopeSuggestion ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                本项目看起来只关心
                {' '}
                {sharing.scopeSuggestion.scope.map((entry) => (
                  <code key={entry} className="mx-0.5 font-mono text-foreground">{entry}</code>
                ))}
                （{sharing.scopeSuggestion.why}）
              </span>
              {onApplySuggestion ? (
                <Button size="sm" onClick={onApplySuggestion} disabled={applying}>
                  {applying ? '固定中…' : '就按这个'}
                </Button>
              ) : null}
              {onDeclareScope ? (
                <button
                  type="button"
                  onClick={onDeclareScope}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  我自己挑
                </button>
              ) : null}
            </div>
          ) : onDeclareScope ? (
            /*
             * 没有可用建议时也得留一个入口。此前这里还要求 warn && selfUnscoped，
             * 于是「一部分服务划了、另一部分没划」的项目两个分支都不满足，用户
             * 再也进不去那个对话框——而这种半划状态恰恰最需要进去看一眼。
             * 已经全划好的项目按钮是低调的文字链，不喧宾夺主。
             */
            <button
              type="button"
              onClick={onDeclareScope}
              className={
                warn && selfUnscoped
                  ? 'rounded border border-warn/50 px-2.5 py-1 text-xs font-medium text-warn hover:bg-warn-soft'
                  : 'text-xs text-muted-foreground underline-offset-2 hover:underline'
              }
            >
              {warn && selfUnscoped ? '挑一下本项目关心的目录' : '看看本项目关心哪些目录'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 绑仓库前的打断内容：这一刻用户正要做出决定，必须当场说清后果。
 *
 * 只给正文，外壳（Dialog/确认按钮）由调用方决定 —— 创建项目和绑仓库两个流程
 * 的外壳不一样，但要说的话是同一句。
 */
export function RepoSharingConfirmBody({
  repoFullName,
  siblings,
  /** 兄弟项目数。明细拿不到时（机器凭据）靠它把话说完整。 */
  siblingCount,
}: {
  repoFullName: string;
  siblings: Array<{ id: string; name: string }>;
  siblingCount?: number;
}): JSX.Element {
  const who = siblings.length > 0
    ? siblings.map((s) => s.name).join('、')
    : `${siblingCount ?? 0} 个别的项目`;
  return (
    <div className="space-y-3 text-sm">
      <p>
        <code className="font-mono">{repoFullName}</code> 已经绑给了
        {' '}
        {who}
        。再绑一个不是错误用法，但从这一刻起有三件事会变：
      </p>
      <ul className="space-y-1.5 pl-4 text-muted-foreground">
        <li className="list-disc">往这个仓库推一次代码，这些项目会<strong className="font-semibold text-foreground">各自</strong>建分支、各自构建一遍。</li>
        <li className="list-disc">删掉其中一个项目，不影响其它项目 —— 但它们的预览分支是各自独立的容器，占的是各自的资源。</li>
        <li className="list-disc">如果它们的环境变量指向同一个数据库，一边写坏另一边立刻可见。</li>
      </ul>
      <p className="text-muted-foreground">
        想让每个项目只在被改到时才重建，给各自的构建配置声明「构建范围」即可。
      </p>
    </div>
  );
}
