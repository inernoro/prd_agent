// 页面骨架（SSOT）——「一个页面长什么样」由这里规定，页面不再各搭各的。
//
// 此前控制台里同时存在至少三套页头（.lg-page-heading / .lg-logs-heading / 各页自写的
// icon+标题 flex 行），四个页面还各自用了不同的居中宽度（1040 / 1060 / 1080 / 1180）。
// 同一层级的东西长得不一样，就是「手工拼凑感」的来源。
//
// 规则见 doc/rule.platform.llm-gateway.console-design-tonality.md 原则 6 / 7：
//   - 容器一律贴边全宽；可读宽度作用在**段落**（--measure）与**表单列**（.lg-form-grid）上，
//     而不是把整个页面居中。
//   - 每页副标题 1 句、正文段落 ≤2 段；超出的解释走四个出口：
//     HelpPopover（字段旁的 ?）/ 空状态 / DetailsBlock（默认收起）/ TutorialLink（外链教程）。
//
// 重要不变量（改这里之前先读）：
//   PageShell / PageBody / PageHeader 必须**透明、无边框**。
//   e2e/llmgw-layout-drift.mjs 的 headingBoxed 会从 h1 向上走 4 层，命中任何边框或非透明
//   底色就判定「标题被卡片包住」——给这几个容器加一句 background 会让 8 条被测路由同时漂移。
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { canOpenTutorials, resolveTutorialHref, usePlatformMapHome } from '@/lib/mapNavigation';
import { BODY_TEXT } from '@/lib/typography';

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ');

/** 页面根：占满内容区、自己不滚动，滚动交给 PageBody。 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('lg-page-shell', className)}>{children}</div>;
}

/**
 * 页头：复用既有的 .lg-page-heading（theme.css 已把 h1 与 p 绑到字阶 SSOT，
 * 且该类无边框无底色，正合上面的 headingBoxed 不变量）。
 *
 * 刻意**不提供 eyebrow**——风格调性规则原则 1 明令「没有副标题层，没有 eyebrow 小标签」。
 * 页面要交代的身份信息请放进 summary（标题下一排小字），而不是标题上方再加一层。
 */
export function PageHeader({ title, subtitle, summary, actions }: {
  title: ReactNode;
  /** 一句话。多于一句请挪进 DetailsBlock 或 HelpPopover。 */
  subtitle?: ReactNode;
  /** 标题下的一排汇总小字，例如「团队 3 · 成员 12 · 密钥 5」。 */
  summary?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="lg-page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
        {summary ? <p className="lg-summary-strip">{summary}</p> : null}
      </div>
      {actions ? <div className="lg-page-actions">{actions}</div> : null}
    </header>
  );
}

/** 独立的汇总指标条（页头之外也要用一排小字时）。 */
export function SummaryStrip({ children }: { children: ReactNode }) {
  return <p className="lg-summary-strip">{children}</p>;
}

/** 内容区：唯一的滚动容器。 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('lg-page-body', className)}>{children}</div>;
}

/** 正文段落：宽度受 --measure 约束，不随屏幕一起变宽。 */
export function Prose({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <p className="lg-prose" style={style}>{children}</p>;
}

/**
 * 表单栅格：列宽固定在 260~320px 且左对齐。
 * 用它替代 `repeat(auto-fit, minmax(N, 1fr))` —— 后者会让输入框跟着屏幕一起变宽，
 * 宽屏下一个 10 字段的表单会被拉成横贯全屏的长条。
 */
export function FormGrid({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="lg-form-grid" style={style}>{children}</div>;
}

/**
 * 出口一：字段旁的 ?。用来收纳「这个字段怎么填 / 这几个选项什么区别」。
 *
 * `align` 决定浮层往哪边展开：触发点靠近容器右缘时必须用 'end'，
 * 否则 288px 的浮层会越过右边界被祖先的 overflow 裁掉（实测右侧文字被切）。
 */
export function HelpPopover({ label, align = 'start', children }: {
  label: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    <details className={cx('lg-help-popover', align === 'end' && 'lg-help-popover--end')}>
      <summary aria-label={`${label}说明`}>?</summary>
      <div role="note">{children}</div>
    </details>
  );
}

/** 出口三：默认收起的「工作原理」。内容区透明无边框，不进「卡片内边距种类」计数。 */
export function DetailsBlock({ title = '工作原理', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="lg-explainer">
      <summary>
        <svg className="lg-explainer-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        {title}
      </summary>
      <div>{children}</div>
    </details>
  );
}

/**
 * 出口四：深链到《模型网关权威教程》对应章节。
 *
 * 只有 MAP 身份且角色够的用户才能打开知识库；其余用户回落到站内学习中心。
 * **绝不渲染死链，也绝不渲染成什么都没有**——否则「想深读的人」在这一档直接断掉。
 */
export function TutorialLink({ chapter, children = '查看教程' }: { chapter?: string; children?: ReactNode }) {
  const { user, tenant } = useAuth();
  const location = useLocation();
  // 订阅权威 MAP 地址：它到达时这条深链要跟着重算（兜底在长预览域名下算不对）。
  usePlatformMapHome();
  const arrow = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7" /><path d="M7 7h10v10" /></svg>
  );
  // 回落到站内学习中心时必须走 router Link：同源部署下 basename 是 `/llmgw`，
  // 裸 <a href="/learn"> 会跳到 MAP 应用的 /learn 而不是控制台的（Codex P2）。
  if (!canOpenTutorials(user, tenant)) {
    return (
      <Link className="lg-tutorial-link" to="/learn" style={BODY_TEXT}>
        {children}
        {arrow}
      </Link>
    );
  }
  // 用 router 的 location（已按 basename 削过）而不是 window.location.pathname，
  // 两个调用方从此同一口径；resolveTutorialHref 内部的 stripConsoleBase 是幂等的。
  const href = resolveTutorialHref(location.pathname, { chapter });
  return (
    <a className="lg-tutorial-link" href={href} style={BODY_TEXT}>
      {children}
      {arrow}
    </a>
  );
}
