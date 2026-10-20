# LLM 网关旧路径物理退场 · 计划

> **版本**：v3.0 | **日期**：2026-10-04 | **状态**：已完成

**一句话**：主系统里调大模型的老路径已经删掉，MAP 只剩「经独立网关调用」这一条路，这份计划只留收尾结论与剩下的两件尾巴。
**谁该读**：负责网关的工程师；想知道「老路径到底删干净没有」的任何人。
**读完能做什么**：说清删了什么、为什么还留着两处、出问题时怎么回滚。

---

## 最后更新

2026-10-04 | 网关退场 | 距离收口：主路径已收口；剩两处尾巴，均不影响 MAP 只走网关这一事实。

| 阶段 | 进度 | 状态 | 当前 blocker | 下一步 | 验收证据 |
| --- | --- | --- | --- | --- | --- |
| S6 删除 MAP 进程内旧路径 | 100% | 已验收 | 无 | 无 | 源码守卫 `Api_LlmGateway_IsHttpOnly`、`ExecDep_HasNoGatewayModeAndProbesGatewayAfterDeploy` 与 compose 守卫全绿 |
| serving 内部 legacy 配置兜底 | 0% | 未开始 | 需要先看新版本上线后哪些调用方还落在这一档 | 按 [debt.platform.llm-gateway.md](./debt.platform.llm-gateway.md) 的四步还债 | 无 |
| S5.5 把网关引擎搬进网关侧项目 | 0% | 未开始 | 无（MAP 已不再构造引擎，前置条件已满足） | 单独开一轮，只搬不改行为 | 无 |

## 删了什么

- **模式开关**：`LlmGateway:Mode`（inproc / shadow / http）连同生产缺省拒绝启动的那套判定，整体删除。MAP 的模型调用只经 `HttpLlmGatewayClient` 打到独立 serving，生产、CDS 预览与本地开发一致。
- **进程内直连**：MAP 不再装配网关引擎；引擎类本身留在基础设施层，因为它是 serving 的执行引擎。
- **影子比对**：MAP 侧的影子路由与写入器、强制采样请求头与贯穿各业务 Run 的采样标记、serving 与控制台的影子读端点、控制台影子页面、`llmshadow_comparisons` 集合的建索引与保留策略。
- **灰度白名单**：按调用方逐个切到 HTTP 的白名单及代码里写死的补充项。
- **分阶段发布机器**：影子、灰度、回滚到 inproc、全量切换这一串阶段脚本，配套的发布台账、影子证据门禁、定时巡检工作流，以及控制台里只服务于切换的三道 gate 与台账 gate。

## 发布与回滚

- 发布只有一种：`fast.sh --commit <40 位提交号> && exec_dep.sh --commit <同一提交号>`。不再需要配置模式，也不再需要经阶段脚本调用。
- 发布脚本强制等待 serving 容器健康，随后从公网网关入口（由 `PRD_AGENT_PUBLIC_BASE_URL` 推出）带 `.env` 里的 serve key 探一次：带 key 就绪、构建 commit 一致、无 key 被拒，任一不过即发布失败；拿不到 key 直接拒绝发布。会真调模型的 D 层 smoke 只在显式给了探测 key 或业务 smoke key 时默认跑。
- 回滚 = 用上一个提交号重新发布。MAP 没有可以退回的进程内旧路径，也不该有。

## 还留着的两处

1. **serving 内部的 legacy 配置兜底**：网关里没配置的调用方会退回 MAP 旧配置选模。它决定的是网关怎么选模型，不是 MAP 走哪条路；删除当天正式机仍在 inproc，切到 HTTP 后其余调用方可能正靠它选模，直接删会让它们解析不到模型。还债步骤见 [debt.platform.llm-gateway.md](./debt.platform.llm-gateway.md)。
2. **网关引擎仍在主系统的基础设施项目里**：搬迁不改运行时行为，此前卡在「MAP 还在装配它」，现在这个前提已经消失，可以单独做。

存量数据：`llmshadow_comparisons` 里的历史文档不再被读写；开启过 TTL 索引的环境会自然过期，没开过的可手工删除该集合（只读历史，不影响任何功能）。

## 关联文档

- [doc/design.platform.llm-gateway.physical-isolation.md](./design.platform.llm-gateway.physical-isolation.md)
- [doc/design.platform.llm-gateway.migration-retrospective.md](./design.platform.llm-gateway.migration-retrospective.md)
- [doc/debt.platform.llm-gateway.md](./debt.platform.llm-gateway.md)
- [doc/debt.platform.llm-gateway.isolation.md](./debt.platform.llm-gateway.isolation.md)
