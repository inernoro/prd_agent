# CDS 项目卡片基础设施误读审计 · 报告

> **版本**：v1.0 | **日期**：2026-05-12 | **状态**：已落地

## 背景

用户在 CDS `/project-list` 看到 MAP 平台项目卡片里出现大量 `api` / `admin` 节点，并且项目列表里出现多个 `fullstack-infra-smoke-*` 项目，直觉判断是 prd-agent 被错误加了大量基础设施。

这次审计的目标不是只解释 UI，而是用线上页面和 E2E 测试确认三件事：

1. MAP/prd-agent 到底有没有越界多出基础设施。
2. 项目卡片统计和预览是否误导用户。
3. `fullstack-infra-smoke-*` 是否是测试残留，以及如何避免再次污染线上。

## 结论

MAP/prd-agent 没有突然多出 MySQL/RabbitMQ 等基础设施。用户看到的“多出来的内容”来自两类问题：

| 类型 | 现象 | 结论 |
|------|------|------|
| 测试项目残留 | `fullstack-infra-smoke-202605120738`、`fullstack-infra-smoke-202605120723`、`fullstack-infra-smoke-202605120649` 出现在项目列表 | 它们是独立 CDS 项目，不属于 MAP/prd-agent；长期留在线上会污染项目总数、运行总数和用户认知 |
| 项目卡片聚合误导 | MAP 卡片里重复出现多组 `api` / `admin`，底部显示 `17/17 服务在线` | 卡片把多个运行分支的服务实例逐个画出来，并且把“运行分支数 / 分支总数”误写成“服务在线” |

## 线上观测

线上 `/project-list` 旧版表现：

| 项目 | 旧版显示 | 问题 |
|------|----------|------|
| MAP平台 | `api admin api admin api admin +11` | 按运行分支实例重复绘制，误以为一个项目多出十几个服务 |
| MAP平台 | `17/17 服务在线` | 实际是运行分支数，不是服务数 |
| fullstack-infra-smoke-* | MySQL / Redis / RabbitMQ | 测试样例项目残留在线上，和 MAP 无关但会出现在同一项目列表 |

新版线上验证表现：

| 项目 | 新版显示 | 含义 |
|------|----------|------|
| MAP平台 | `admin x9`、`api x8` | 同一服务 profile 聚合显示一次，`xN` 表示 N 个运行分支里有该服务 |
| MAP平台 | `17/18 服务在线` | 真实 app service 实例在线数 |
| MAP平台 | `9/10 分支运行` | 分支运行数单独展示，不再混进服务统计 |

## 代码修复

| 文件 | 改动 |
|------|------|
| `cds/src/routes/projects.ts` | `statsFor()` 将 `appServices` 从“运行实例列表”改为“按 profileId 聚合的服务类型列表”，新增 `runningCount` |
| `cds/web/src/pages/ProjectListPage.tsx` | 项目卡片显示 `api x8` / `admin x9`，底部拆成“服务在线”和“分支运行”两项 |
| `cds/tests/routes/projects.test.ts` | 增加 E2E 级路由断言：同一个 `api` 在两个运行分支中只返回一个卡片节点，同时保留 `runningCount=2` |

关联提交：

```text
6faff68a fix: clarify CDS project card services
```

## 验收记录

本地验证：

```bash
npm --prefix cds test -- tests/routes/projects.test.ts
npm --prefix cds/web run build
npm --prefix cds run build
```

结果：

| 项目 | 结果 |
|------|------|
| `tests/routes/projects.test.ts` | 65 passed |
| `cds/web` production build | passed |
| `cds` TypeScript build | passed |

线上 E2E 验证：

1. 打开 `https://cds.miduo.org/branch-panel/prd-agent-main?project=prd-agent`。
2. 确认 `当前运行`、`GitHub 目标`、`最近拉取后` 均为 `6faff68a`。
3. 确认最近部署时间为 `2026/5/12 19:33:34`。
4. 打开 `https://cds.miduo.org/project-list`。
5. 确认 MAP 卡片显示 `admin x9`、`api x8`。
6. 确认 MAP 卡片显示 `17/18 服务在线` 和 `9/10 分支运行`。

## 自更新补充发现

这次还复现了一个容易误判的路径：

1. `prd-agent-main` 分支部署到新 commit 后，分支详情页已经是 `6faff68a`。
2. 但 `cds.miduo.org/project-list` 是 CDS 控制面自身前端，不会因为分支预览部署自动换 bundle。
3. 必须通过 CDS 自更新完成 web build 后，控制面前端才会切到新 bundle。
4. 页面曾显示“后端 6faff68a / 前端 0f91a6f”，这是判断“后端已更新但前端 bundle 旧”的关键证据。

以后遇到“必须点击更新/刷新才看到真实效果”时，先看控制面左下角或维护页是否存在后端 commit 与前端 bundle commit 不一致。

## 后续规则

### 1. 测试项目不能长期留在线上

`fullstack-infra-smoke-*` 这类项目只能用于验收。线上验收结束后必须二选一：

| 场景 | 处理 |
|------|------|
| 只是临时验证 CDS 能力 | 删除项目，确保 project、branch、buildProfile、infraService、routingRule 级联清理 |
| 需要保留作为演示样例 | 明确改名为 demo 项目，并在项目描述里写清用途和负责人 |

### 2. 项目卡片必须区分三个维度

| 维度 | 含义 | UI 文案 |
|------|------|---------|
| 服务实例 | 各分支实际运行的 app service 容器数量 | `17/18 服务在线` |
| 分支 | 至少有一个服务运行的分支数量 | `9/10 分支运行` |
| 基础设施 | 项目级 infra service 数量 | `3/3 infra` |

禁止再把分支数写成服务数。

### 3. 视觉验收必须看真实线上页面

这类问题不是单纯接口测试能发现的。验收必须包含：

1. DOM 文本断言：确认 `服务在线` 与 `分支运行` 同时存在。
2. 视觉检查：确认卡片预览只出现聚合后的 `api xN` / `admin xN`。
3. 控制面版本检查：确认后端 commit 与前端 bundle commit 一致。

## 未处理事项

| 项 | 状态 | 说明 |
|----|------|------|
| 删除线上 `fullstack-infra-smoke-*` 残留项目 | 待确认 | 删除会停止并清理真实线上项目，属于破坏性操作，需要用户明确确认 |
| 自动化浏览器视觉回归 | 未落地 | 本次做了线上 DOM + 页面观察；如需长期防回归，应补 Playwright 视觉或组件级截图测试 |

