// 字号角色表（SSOT）——「什么角色用哪一档」由系统规定，页面不再各写各的。
//
// 档位本身在 theme.css 的 :root 定义（--fs-title / --fs-metric / --fs-heading /
// --fs-body / --fs-secondary / --fs-caption / --fs-micro）。只有档位不够：
// 同样是「表格单元格」，请求记录页用 14px、Provider 页用 12px，看上去就是两套产品。
// 本文件把角色钉死到档位，所有页面 spread 这里的常量，改一次全站一致。
//
//   角色                     档位              典型用处
//   页面标题                 --fs-title 20     h1（走 .lg-title / .lg-page-heading）
//   指标数字                 --fs-metric 17    统计卡的大数字
//   卡片 / 分区标题          --fs-heading 15   卡片头部
//   正文 / 表格 / 表单输入   --fs-body 14      用户要读的内容，默认档
//   次要说明 / 字段名 / 工具条 --fs-secondary 13 辅助信息与紧凑控件
//   角标 / chip / tooltip    --fs-caption 12   一眼扫过的标记
//   指标 caption             --fs-micro 11     下限，仅用于指标下方的小字
//
// 判定口诀：用户需要「读」的内容一律 --fs-body；只有「扫一眼」的标记才允许更小。
import type { CSSProperties } from 'react';

/** 表头：与请求记录页表头同款（14px/500，muted，42px 行高）。 */
export const TABLE_HEAD_CELL: CSSProperties = {
  height: 42,
  padding: '0 12px',
  textAlign: 'left',
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-body)',
  fontWeight: 500,
  lineHeight: 'var(--lh-body)',
  whiteSpace: 'nowrap',
};

/** 表格单元格：与请求记录页数据行同款（14px/450，行高 1.625，约 46px 行）。 */
export const TABLE_CELL: CSSProperties = {
  padding: '11px 12px',
  borderTop: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-body)',
  fontWeight: 450,
  lineHeight: 'var(--lh-body)',
  verticalAlign: 'middle',
};

/** 次要列（时间、备注一类）：字号不降，只降对比度，避免整页越读越费劲。 */
export const TABLE_CELL_MUTED: CSSProperties = {
  ...TABLE_CELL,
  color: 'var(--log-text-muted)',
};

/** 表单字段名。 */
export const FIELD_LABEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-secondary)',
  fontWeight: 600,
};

/** 表单输入框：用户要读自己填的值，走正文档；高度对齐请求记录页控件。 */
export const FIELD_INPUT: CSSProperties = {
  minWidth: 0,
  width: '100%',
  height: 36,
  boxSizing: 'border-box',
  padding: '0 10px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 'var(--fs-body)',
};

/** 工具条上的紧凑控件（筛选下拉、搜索框）：13px + 36px 高，同请求记录页工具条。 */
export const TOOLBAR_CONTROL: CSSProperties = {
  minWidth: 0,
  height: 36,
  boxSizing: 'border-box',
  padding: '0 10px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
  color: 'var(--text-secondary)',
  fontFamily: 'inherit',
  fontSize: 'var(--fs-secondary)',
};

/** 正文说明（标题下的那句话、卡片里成段的解释）。 */
export const BODY_TEXT: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
};

/** 次要提示（补充说明、字段下方的一行提醒）。 */
export const HINT_TEXT: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-secondary)',
  lineHeight: 1.6,
};

/** 等宽标识（请求 ID、key 前缀、模型 id）。 */
export const MONO_META: CSSProperties = {
  color: 'var(--log-text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-secondary)',
};

/** 角标 / chip：只需扫一眼，可以到 12px。 */
export const CHIP_TEXT: CSSProperties = {
  fontSize: 'var(--fs-caption)',
  lineHeight: 1.5,
};

/** 指标数字与其下方 caption。 */
export const METRIC_VALUE: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-metric)',
  fontWeight: 650,
};

export const METRIC_CAPTION: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 'var(--fs-micro)',
};

/** 卡片 / 分区标题。 */
export const SECTION_TITLE: CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: 'var(--fs-heading)',
  fontWeight: 650,
};
