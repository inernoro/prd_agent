// 组件规格表（SSOT）——「同一角色只允许有一种规格」。
//
// 字号有 theme.css 的七档 + lib/typography.ts 的角色映射管着；
// 但「卡片内边距几种、chip 几种、主操作按钮长什么样、卡片底部操作行怎么排」
// 一直是各页各写，结果同一页里卡片内边距 4~5 种、间距 9 种、chip 2 种，
// 眼睛看到的就是「这里松那里紧」的手工感。本文件把这些规格钉死。
//
// 判据（e2e/llmgw-layout-drift.mjs 会量）：
//   卡片内边距 1 种 / 卡片圆角 1 种 / chip 1 种 / 主操作按钮 1 种 / 容器间距 ≤3 种。
import type { CSSProperties } from 'react';

/** 卡片内边距——全站唯一值。需要更紧凑的行内小卡用 INSET_PADDING。 */
export const CARD_PADDING = 14;

/** 卡片内部的次级容器（成员条、键值块）——比卡片小一档，仅此一个备选值。 */
export const INSET_PADDING = 10;

/**
 * 容器间距四档——**新代码从这里挑**。
 * 存量页面还留着少量历史值（基准页自己就在用 4/7/16），不做一次性全量归并；
 * 由漂移检测按「种类数不超过基准页」兜底，避免越改越乱。
 */
export const GAP = { tight: 6, normal: 8, section: 12, page: 16 } as const;

/** 页面主区块之间的间距（页头 → 卡片 → 卡片）。 */
export const PAGE_GAP = GAP.section;

/** 卡片：外观由 ui.tsx 的 Card 提供，这里只补内边距，避免各页各拍一个数。 */
export const CARD_BODY: CSSProperties = { padding: CARD_PADDING };

/** 卡片内的次级块（灰底小容器）。 */
export const INSET_BLOCK: CSSProperties = {
  padding: INSET_PADDING,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
};

/**
 * 卡片底部操作行：一律用 ghost 尺寸 sm 的按钮成组右对齐。
 * 此前三个页面三种写法——文字+icon 混排、纯按钮、纯文字链接。
 */
export const CARD_ACTIONS: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.tight,
  flexWrap: 'wrap',
};

/**
 * 页面主操作按钮的统一规格：`<Button variant="primary" size="sm">纯文字</Button>`。
 * 不带 icon、不用 md 尺寸——多数页面已经是这样，少数派（Exchange 的大号带 + 号按钮）向多数派靠。
 * 这里导出的是判定用的说明常量，实际渲染仍走 ui.tsx 的 Button。
 */
export const PRIMARY_ACTION_SIZE = 'sm' as const;

/** 汇总指标条：一排小字跟在页面标题下，不占卡片（请求记录页已验证的做法）。 */
export const SUMMARY_STRIP_CLASS = 'lg-summary-strip';
