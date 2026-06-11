# 2026-06-09 知识库验收报告图标与列表样式

## 背景

知识库列表中的验收报告此前仍使用普通文档图标，并通过左侧竖向色条表达验收结论。实际扫读时，左侧色条和条目图标含义重叠，且验收报告的文档类型不够明确。

## 变更

- 验收报告条目识别 `metadata.kind=acceptance-report`、`metadata.type=acceptance-report`、合法 `metadata.verdict`，以及历史标签 `视觉验收` / `验收报告`。
- 验收报告使用 `ClipboardCheck` 图标，与行业里常见的“清单 + 勾选”验收/审核语义一致。
- 移除知识库条目左侧验收结论竖条和选中态竖条；结论继续由 `通过 L1`、`有条件 L2` 等 chip 表达，避免同一状态重复编码。

## 验证

- `pnpm --prefix prd-admin tsc --noEmit`
