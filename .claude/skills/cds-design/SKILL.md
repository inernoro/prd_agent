---
name: cds-design
description: 发布 CDS 框架、从需求出设计稿、续版、交付实现和复验。用户说「/cds-design」「发布框架」「出一版设计」「帮我实现 DSN-xxx」时使用。
---

# CDS 设计

## 接入

1. 运行 `node <技能根>/cds/scripts/skill-fresh.mjs`。需要更新时，按 CDS 接入说明在当前工作区安装完整技能包。
2. 用 `cdscli setup-check --host <CDS 地址> --project <项目 ID> --design-access publish` 验证已有授权。缺少发布权限时按 [接入说明](../cds/reference/design-intake.md) 发起一次申请。
3. 读 `cdscli design intake` 或 MCP `cds_design_read` 的 `intake`。核对项目、系统、模块、需求与框架。

## 发布框架

1. 回读 `frameworks`，检查当前项目是否已有同一框架。续版沿用 `frameworkId`，以 `latestVersion` 为当前版本。
2. 用现有设计发布授权调用 `cdscli framework publish` 或 MCP `cds_design_framework_publish`。首发的 `expectedVersion` 为 0。详见 [发布框架](../cds/reference/design-intake.md#发布框架)。
3. 回读服务端给出的框架编号、版本、材料和来源。向委托方交付该版本的回执。需要试用时，在稿件中指定框架版本。

## 设计稿件

按 [设计闭环](../cds/reference/design-loop.md) 读取已交接需求、采用的框架和同稿未关闭反馈。以稳定 `designKey` 匹配首发或续版，按 [出稿和发布规则](../cds/reference/design-intake.md) 预览、自检、发布私有归档并回读。交付同一份稿件地址、版本和待对齐的事项，实现与复核在 CDS 原线程交接。

为原型首页声明可打开的入口和就绪条件。CDS 发布后自动生成设计库封面，交付包省略该截图。
