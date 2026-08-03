---
name: stable-smoke
version: 1.3.0
description: Runs a recurring dual-environment synthetic regression suite for critical PRD Agent journeys and converts every escaped defect into a permanent smoke case. Trigger words: "/稳测", "稳定冒烟", "每两日测试", "stable smoke", "synthetic monitoring".
---

# 稳定冒烟

> 触发：`/稳测`、`稳定冒烟`、`每两日测试`、`stable smoke`
>
> 行业归类：Synthetic Monitoring；本项目中文名：稳定冒烟。

每 48 小时对 CDS 环境和正式环境执行同一套关键用户旅程。CDS 环境是独立的验证环境，不称为“测试环境”；正式环境固定为 `https://map.ebcone.net`。CDS 环境负责完整写入、异常和恢复；正式环境只在专用合成账号与专用数据域内执行限额写入。任何线上或验收逃逸问题，首次修复时必须新增永久回归用例。

业务功能线和面包屑见 [reference/business-function-catalog.json](reference/business-function-catalog.json)，详细用例见 [reference/test-matrix.md](reference/test-matrix.md)，问题沉淀格式见 [reference/regression-ledger.md](reference/regression-ledger.md)，合成登录和调度操作见 [reference/auth-and-schedule.md](reference/auth-and-schedule.md)，非敏感身份状态与安全存储引用见 [reference/credential-registry.json](reference/credential-registry.json)。涉及登录、部署或自动化运行时必须先读取凭据登记表，禁止凭会话记忆猜测当前账号状态。

## 适用场景

- 每 48 小时例行检查 CDS 环境与正式环境。
- 发版前后验证录音、文件解析、短视频解析、视频创作、文学创作和视觉创作。
- 用户或监控发现一次新问题后，将其固化为永久用例。
- 对比两个环境的功能、模型、文案和产物差异。
- 输出按模块归类、带证据和恢复建议的稳定性报告。

## 不适用场景

- 单个 Controller 的临时接口检查，使用 `/smoke`。
- 单个功能的一次性视觉验收，使用 `/验收`。
- 生产发布操作和回滚，使用 `/hotfix-prod`。

## 固定调用方式

```text
/稳测 all
/稳测 cds
/稳测 prod
/稳测 module=recording,visual,multi-image
/稳测 regressions-since=2026-08-01
/稳测 login environment=cds returnUrl=/visual-agent minutes=3
```

无参数时等价于 `/稳测 all`，必须先 CDS 环境、后正式环境。

## 强制规则

1. 环境地址只能来自权威配置。CDS 环境调用 `preview-url`；正式环境读取已配置的生产目标。缺失时报告阻塞，禁止拼接或猜域名。
2. 正式环境使用专用合成账号、专用知识库、专用工作区和 `stsmk-` 数据前缀，禁止读取、修改或删除真实用户数据。
3. CDS 环境跑完整正向、负向、故障恢复和清理；正式环境跑健康检查、最小真实产物和清理，不做破坏性故障注入。
4. 测试不能只断言 HTTP 200。必须断言业务状态、阶段进度、最终产物、用户可读错误和清理结果。
5. 每个长任务都要断言阶段持续变化，静止等待超过 2 秒视为体验失败。
6. 每个失败最多做一次确定性重试。重试通过仍记为 `flaky`，不得改成通过后静默。
7. 首次发现的新问题必须在修复提交中追加永久用例；同一根因第二次逃逸，除了产品缺陷，还记一条稳定性流程 P1。
8. 原始 HTTP、Provider、模型协议、token 和异常堆栈只能进入脱敏管理员证据，用户界面必须说明结果与恢复动作。
9. 所有写入用例必须幂等并自动清理。清理失败单独记 P1，不得污染下一轮。
10. 任一必跑模块被跳过时，整轮最多为 `conditional`，不得报告完整通过。
11. SSO 环境不得开启全局密码破窗供自动化使用。只能使用合成测试专用账号、一次性票据和不可续期短会话。
12. 登录票据正文、AI 超级密钥和访问令牌不得写入报告、截图、日志、命令历史或本地运行产物。
13. 业务功能台账是复测范围 SSOT。每条 P0/P1 功能线必须有稳定 id、业务面包屑、代码路径、双环境策略、caseId、产物断言、清理和 CDS 回滚动作。
14. PR 代码变更按 `sourcePrefixes` 自动纳入功能线，同时追加所有 active 永久回归；未映射的核心代码变更必须阻断，不允许静默漏测。
15. conditional 或 fail 只通过 MAP 站内通知定向发送给配置用户，禁止发全局通知，禁止发送到 Slack。

## 每轮工作流

```text
Stable Smoke Progress:
- [ ] 1. 生成 runId，加载矩阵与回归台账
- [ ] 2. 解析 CDS 环境和正式环境权威地址
- [ ] 3. 检查凭据、模型、配额、存储与外部依赖
- [ ] 4. 在 CDS 环境执行完整矩阵
- [ ] 5. 在正式环境执行安全矩阵
- [ ] 6. 执行桌面端与真实触控移动端关键旅程
- [ ] 7. 比对双环境能力、文案、阶段和产物
- [ ] 8. 对失败做一次确定性重试并分类
- [ ] 9. 将新问题写入回归台账和稳定冒烟候选
- [ ] 10. 按模块归档报告、截图、日志和 requestId
```

### 1. 运行前置

- runId：`stsmk-{YYYYMMDD-HHmm}-{shortid}`。
- 测试账号必须有独立的用户、租户和资源前缀。
- 固定小样本存放在测试资产库：短音频、静音音频、损坏文件、短视频链接、两张和三张参考图、最短视频脚本。
- 记录每个模块的逻辑模型、Offering 健康、配额和外部依赖状态。

### 2. CDS 环境

按 `reference/test-matrix.md` 跑全量：入口、上传、阶段进度、结果、取消、重试、断网恢复、幂等、错误文案、移动端和清理。允许使用专用依赖模拟故障，禁止影响共享数据。

### 3. 正式环境

按相同 caseId 跑生产安全变体：

- 只使用 `stsmk-` 专用资源。
- 音频、图片和视频都使用最小样本与最低成本档。
- 每种生成能力至少产生一个真实可读取产物，不能只查配置。
- 禁止故意打满限流、关闭 Provider、删除共享配置或修改真实模型路由。
- 用例完成后回读确认资源已删除或进入固定可复用池。

### 4. 双环境比较

比较以下字段，不要求内部 ID 相同：

- 入口是否可达、权限是否一致。
- 可用逻辑模型和能力标签是否符合环境发布意图。
- 阶段事件顺序、最终状态和用户文案是否一致。
- 产物 MIME、尺寸、时长、可下载性和内容非空。
- 错误是否为用户可理解文案，管理员是否能通过 requestId 找到根因。

### 5. 失败分类

| 分类 | 判定 | 动作 |
|---|---|---|
| product | 功能、数据或产物错误 | 建缺陷，阻断对应模块 |
| environment | 凭据、配额、依赖或部署异常 | 标记环境失败，不伪装成产品通过 |
| flaky | 首次失败、唯一一次重试通过 | 保留失败证据，进入抖动治理 |
| test | 定位器、夹具或断言错误 | 修测试后重跑，不改变产品结论 |
| cleanup | 测试资源未清理 | P1，先清理再开启下一轮 |

## 问题只能出现一次

每个逃逸问题必须获得稳定 caseId：`REG-{module}-{number}`。

修复关闭条件同时满足：

1. 根因明确，不以现象文案代替根因。
2. 新增最小复现夹具。
3. CDS 环境复现旧问题，并证明修复后通过。
4. 正式环境跑安全变体或给出不可运行的明确边界。
5. caseId 写入 `reference/regression-ledger.md` 对应台账。
6. 加入以后每轮 `/稳测` 的必跑集合。

同一 caseId 或同一根因再次出现时，报告必须写明“重复逃逸”，严重级至少 P1，并检查为什么回归用例没有拦住。

## 调度契约

- 自动化名称：`stable-smoke-48h`。
- 周期：每 48 小时一次，Asia/Shanghai 02:17 启动；同一时刻只允许一轮运行。
- 顺序：CDS 环境全量完成后，再运行正式环境安全矩阵。
- 闸门：CDS 环境出现 P0、数据污染或清理失败时，正式环境只跑只读健康检查，跳过写入并把整轮判为 fail。
- 超时：单模块 30 分钟，整轮 120 分钟；超时按失败处理，不继续播放进度文案。
- 通知：成功只归档；conditional 或 fail 必须发送模块、caseId、环境、requestId、证据和恢复动作。
- 通知实现：`scripts/stable-smoke-notify.mjs` 只调用 MAP `/api/dashboard/notifications/events`，缺少目标用户 ID 时拒绝发送，避免误发全员。
- 保留：报告和截图至少 90 天；回归台账永久保留。
- 实现：Codex 桌面端本地自动化 `stable-smoke-48h`，执行环境必须为 `local`，工作目录固定为项目主工作区；调度使用 `RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=2;BYMINUTE=17`。
- 边界：GitHub Actions 不参与 48 小时调度。CDS 负责 CDS 环境、部署状态和预览入口证据；本地自动化负责浏览器、凭据装载、双环境执行、报告归档和 MAP 通知。

## 输出格式

```markdown
# 稳定冒烟报告 · {runId}

Verdict: pass | conditional | fail

| 模块 | CDS 环境 | 正式环境 | 用例数 | 失败 | flaky | 产物 | 耗时 |
|---|---|---|---:|---:|---:|---|---:|
| 录音 | pass | pass | 12 | 0 | 0 | 原文已保存 | 42s |

## 模块：{模块名}

| caseId | 环境 | 结果 | 阶段/产物断言 | requestId | 证据 | 恢复动作 |
|---|---|---|---|---|---|---|

## 新增永久回归

| caseId | 来源问题 | 根因 | 新夹具 | 首次通过证据 | 所属冒烟集合 |
|---|---|---|---|---|---|

## 清理结果

| 环境 | 创建数 | 清理数 | 残留数 | 结论 |
|---|---:|---:|---:|---|
```

报告必须按模块列出，不得只给总通过率。视觉功能使用 `/验收` 归档截图；接口链路复用 `/smoke`；复杂范围先用 `/验收场景` 编排。

## 业务功能台账与版本自动纳入

`reference/business-function-catalog.json` 是机器可读 SSOT，`scripts/stable-smoke-plan.mjs` 负责三件事：

1. 校验功能线的面包屑、双环境策略、caseId、清理和回滚字段完整。
2. 48 小时任务固定纳入全量；PR 按代码路径纳入受影响功能线并追加 active 永久回归。
3. 把 `catalogVersion`、commit、功能线和 caseId 固定成本地计划产物，报告必须引用同一版本。

功能线的 `automationStatus` 只能是 `planned`、`entry`、`contract`、`contract-and-entry` 或 `journey`。只要必跑功能仍为 `planned`，整轮最多为 conditional，不能用入口可达冒充业务旅程通过。

## 端到端示例

输入：

```text
/稳测 module=recording,multi-image
```

执行：解析 CDS 与正式地址；分别跑录音上传、转录、保存、关闭后恢复，以及两图和三图生成、进度、结果和错误恢复；清理所有 `stsmk-` 资源。

输出：按“录音”和“多图视觉创作”分组列出两个环境的结果。若多图第三张丢失，创建 `REG-multi-image-001`，补三图夹具和永久断言，本轮 verdict 为 fail。

## 技能协作

- 上游：`acceptance-scenario-orchestrator` 负责复杂范围和证据契约。
- 执行：`smoke-test` 负责链式 API，`create-visual-test-to-kb` 负责真人浏览器取证。
- 环境：`preview-url` 提供 CDS 环境真实入口；正式环境固定核对 `https://map.ebcone.net`，不得把 CDS 地址称为测试地址。
- 收尾：`task-handoff-checklist` 检查测试、风险、文档和后续责任。

## 质量自评

| 维度 | 得分 |
|---|---:|
| Core Quality | 9.2/10 |
| Conciseness | 8.6/10 |
| Degrees of Freedom | 9.2/10 |
| Structure & Naming | 9.3/10 |
| Workflow & Feedback | 9.5/10 |
| Examples | 9.0/10 |
| Ecosystem | 9.5/10 |
| 加权总分 | 9.1/10 |
