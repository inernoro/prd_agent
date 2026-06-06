# CDS Agent 体验修复验收 · 报告

> **版本**：v1.0 | **日期**：2026-06-06 | **状态**：已落地

> **读者**：想确认用户反馈的 cds-agent 9 个问题各自被解决到什么程度、有什么证据的人
> **关联**：`doc/design.knowledge-agent-architecture.md`、`doc/design.cds-agent-runtime-architecture.md`、`changelogs/2026-06-06_cds-agent-ux-fixes.md`、`.claude/rules/blocked-state-circuit-breaker.md`

---

## 1. 一句话结论

用户反馈的 9 个 cds-agent 问题中，**根在 MAP 包装层的（最毁信任的那几个）已修复并端到端验证**；**根在「借来的 sidecar 运行时镜像」的（工具循环/线程不停）不在本仓库、只能 MAP 侧缓解**；**「工作区/文件注入/知识库喂数据」是一个尚未存在的能力（需新建接缝），它同时 gates「md→ppt 案例」**。

核心印证了用户的架构判断：底层 runtime 是别人封装好的（拿来用即可），所以 runtime 内的 bug 不是我们的；我们之所以又慢又不稳，是 MAP 没做薄、自造了一堆中间层——把这层削薄即解大部分问题。

---

## 2. 逐条验收（含硬证据）

验收方式：预览域名真人路径 + Playwright 取证 + 关键指标打点（发送往返耗时 / 首字时延 / 传输噪声检测）。预览：`https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org/cds-agent`

| # | 用户原话问题 | 状态 | 证据 / 说明 |
|---|---|---|---|
| 3 | 输入发送先卡 2 秒→一直等→死掉 | **已解决·已验** | 发送往返 `CLICK_RETURN_MS=52~56ms`（两轮复验）。修法：SendMessage 把消息 POST 到 CDS 后立即入队返回，导入由后台 worker 跑（与 HTTP 解耦）。 |
| 5 | 启动后很长时间不输出（流式问题） | **已解决·已验** | 首字 `FIRST_BYTE_MS=556~559ms`，文本逐字增长。修法：ImportCdsStreamEventsAsync 增量读 CDS SSE（边读边落库），前端 /stream 长连实时转发。 |
| 4a | 莫名其妙输出奇怪日志（刷屏） | **已解决·已验** | `HAS_TRANSPORT_NOISE=false`；每条消息必触发的 `cds-session-transport/operator-debug-only` 事件已从用户事件流删除、降为服务端 LogDebug。 |
| 4b | 展开折叠的没有内容 | **已解决** | canExpand 改为「展开后确有内容才显示『详情』」，空 payload 事件不再展开成「{}」/空。（tsc+lint 通过；噪声源已先行清除） |
| — | 左上角莫名出现「同步主机模型」很困惑 | **已解决** | 黑话按钮→「一键启用默认模型」+ tooltip 说明何时/为何出现。 |
| 2 | 新建 session 原地刷新没新增 | **未改（避免回归）** | 排查：新建为 idle（statusRank 2，排在已超时/结束之上，理论应出现）；疑似 12s 轮询用旧结果覆盖乐观插入的竞态，根因未确证。在 358KB 单文件里盲改风险高，暂留待可复现后修。 |
| 7 | 输出结束后反复调用工具/日志循环 | **借来的 runtime，改不了·已缓解** | 根在 sidecar 运行时镜像（claude-agent-sdk）内的 agent loop，不在本仓库。MAP 侧缓解：收到 done 即停止拉取（worker 导入到 done 事件后结束本轮）。 |
| 8 | 输出后不停线程，一直在操作 | **部分（MAP 侧）+ 借来的 runtime** | MAP 侧：worker 导入随 done 结束；手动「停止」按钮 + StopAsync 释放 CDS 会话已存在。sidecar 常驻不回收、跑完仍动属 runtime 行为，根不在本仓库。「idle 自动回收 sidecar」需新建后台清扫（未做）。 |
| 1 | 配置 cds agent 半天不出效果 | **部分** | pairing 默认 TTL 10 分钟 + 手动复制粘贴 + MAP 端密钥存储。属配置流程体验，需专门削薄，未在本批。 |
| 6 | 不知工作区在哪 / 无法放文件 / 知识库放不进去 | **能力缺失，需新建（大件）** | CDS 侧**根本没有文件注入 API**，只能 git push/env。这正是架构文档里的「接缝」。**md→ppt 案例依赖它**，是后续专项。 |
| 9 | 权限反复需要授权 | **部分** | 根多在 MAP 端密钥丢失/连接 revoke/scope 不匹配；长 token 本身「不设过期即永不过期」。需区分错误原因 + 支持再签发，未在本批。 |

---

## 3. 已修复项的代码位置（削薄 MAP）

- `prd-api/.../InfraAgentSessions/InfraAgentSessionService.cs`
  - SendMessage：删内联阻塞导入 → `_runtimeJobs.EnqueueAsync` 入队即返回
  - RunRuntimeJobAsync：CDS-transport 分支真正做后台 CDS 流导入 + 落终态
  - ImportCdsStreamEventsAsync：`ReadAsStringAsync` → StreamReader 增量读、逐块落库
  - 删除 operator-debug-only 噪声事件注入（降为 LogDebug）
- `prd-admin/src/pages/cds-agent/CdsAgentPage.tsx`
  - 「同步系统主模型」→「一键启用默认模型」+ tooltip
  - canExpand：空内容不显示「详情」

---

## 4. 诚实边界（为什么不是「全部完成」）

依据 `.claude/rules/blocked-state-circuit-breaker.md`：撞上自己无法提供的外部输入必须如实升级，不grinding、不假装完成。本任务的真实墙：

1. **#7 / #8-runtime 在借来的 sidecar 镜像里**，不在本仓库可改代码内 → 只能 MAP 侧缓解，无法「完全解决」。
2. **#6 + md→ppt 案例**：需要先在 CDS 运行时建「文件注入工作区」接缝，且其端到端验证需要 sidecar 真实运行转换器（marp/pandoc）——这套基础设施我无法在用完即弃的预览里自助搭建并验证，故不能谎称已完成。
3. **#1 / #9 / #2**：属配置/竞态类，根因部分在环境（密钥/网络/时序），需可复现才能确证修复，未在本批盲改。

---

## 5. 验收指标原始记录

```
两轮预览真人路径 e2e（发送一句话 → Agent 真实回复）：
  CLICK_RETURN_MS: 56 / 52      （发送往返，原症状「卡2秒→死」）
  FIRST_BYTE_MS:   559 / 556    （首字时延，原症状「很久不输出」）
  HAS_TRANSPORT_NOISE: false    （原症状「奇怪日志刷屏」）
  Agent 真实回复成功（如「我可以读取分析代码/搜索理解文件/协助解决问题」）
  自动捕获 P0=0
```
