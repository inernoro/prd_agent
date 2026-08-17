# 模型路由能力契约治理 · 状态看板

> **版本**：v1.0 | **日期**：2026-08-17 | **状态**：开发中

**一句话**：这块看板回答「模型池反复不可用这个故障族治到哪一步了、卡在哪、下一步做什么、凭什么说这步过了」。
**谁该读**：跟进这次根因治理的人；决定能不能合并、能不能发布的人。
**读完能做什么**：不看代码也能说出当前进度、剩余阻塞与每一步的证据在哪。

---

**最后更新**：2026-08-17 19:05 | **更新人/轨道**：Claude（能力契约轨道）
**距离可发布**：代码与 CI 判据已就绪；**缺真人视觉验收与正式配置迁移演练**，因此现在不可发布。

## 阶段看板

| 阶段 | 进度% | 状态 | 当前 blocker | 下一步 | 验收证据 |
|---|---|---|---|---|---|
| W1 能力契约唯一化 | 100 | 已验收 | 无 | — | `GatewayCapabilityContractTests`、`GatewayCapabilityContractMirrorGuardTests`（表 + 行为双向比对，可红） |
| W2 结构化失败原因 | 100 | 已验收 | 无 | — | `GatewayRouteFailureTaxonomyTests`、`GatewayRoutingWiringGuardTests.每一处路由失败都必须带结构化错误码` |
| W3 readiness 用生产判据 | 100 | 已验收 | 无 | — | `GatewayScenarioCapabilityReadinessTests`（含正式数据形态回放）、`GatewayRoutingWiringGuardTests.Readiness_使用生产同款场景判据` |
| W4 能力迁移与契约版本 | 100 | 已部署 | 无 | 正式环境跑一次迁移并核对审计端点 | `LogicalModelCapabilityPolicyTests`（幂等、未知不丢弃、无残留别名）；只读审计端点 `/gw/logical-models/capability-audit` |
| W5 故障域隔离 | 100 | 已验收 | 无 | — | `GatewayFaultDomainIsolationTests`（生图挂不影响对话/ASR，反向亦然，单成员失败不判死整池） |
| W6 CI/CDS 接线修正 | 100 | 已部署 | 无 | — | `branch-image.yml` 的 `llmgw_serve` 过滤补 `prd-api/**`；CDS 五服务同 commit |
| W7 真人视觉验收 | 0 | 阻塞 | 需要能登录预览环境的真人（或可用的浏览器取证通道）走生图 / ASR / 对话三条链路并做故障注入 | 由用户执行 `/验收`，或授权本会话使用浏览器取证 | 无 |
| W8 正式配置迁移与回滚演练 | 0 | 未开始 | 需要用户批准在正式环境执行能力迁移 | 先在预览环境跑迁移拿到迁移前后对象统计，再申请正式执行 | 无 |

## 可发布 Gate（七条全绿才准发）

| # | 判据 | 当前 |
|---|---|---|
| 1 | 五服务运行同一 commit | 已满足（CDS 五个容器均为同一 sha 镜像） |
| 2 | CI 全绿（含 `dotnet test`） | 见下方「测试证据」 |
| 3 | 能力契约两侧无漂移 | 已满足（镜像守卫） |
| 4 | 每处路由失败都带结构化原因 | 已满足（源码守卫） |
| 5 | 正式数据形态回放可路由 | 已满足（回放用例） |
| 6 | 真人视觉验收留证 | **未满足** |
| 7 | 正式配置迁移计划 + 回滚方案 | **未满足** |

任一未满足即为「不可发布」，不接受「先发再补」。

## 术语（给不看代码的人）

- **能力**：一个模型「能拿来干什么」的标记，例如「能生图」「能做图生图」。
- **别名**：同一个能力的旧写法。事故当天正式数据里写的是旧写法，代码只认新写法。
- **appCaller**：哪个功能在调模型，例如「视觉创作的文生图」。
- **readiness**：网关自检，回答「这台机器现在能不能接流量」。
- **Offering**：一个逻辑模型背后的一条真实上游线路。

## 关联

- 设计：[模型路由能力契约与故障域隔离](./design.platform.llm-routing.capability-contract.md)
- 债务：[LLM 网关与模型池 · 债务台账](./debt.platform.llm-gateway.md)（本次新增三条 `2026-08-17-*`）
- 既有整改计划：[LLM Gateway 故障隔离与恢复](./plan.platform.llm-gateway.resilience.md)
