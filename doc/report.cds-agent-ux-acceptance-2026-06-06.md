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

---

## 6. 增补（2026-06-07）：思考过程透出 + #3 慢首字根治 + 重要更正

### 6.1 更正 §4 的错误结论：sidecar 运行时就在本仓库

上一轮 §4 写「#7/#8/sidecar 不在本仓库、只能 MAP 侧缓解」是**错的**。边车运行时源码就在 `claude-sdk-sidecar/`（Python FastAPI + 官方 `claude-agent-sdk` + `anthropic`），镜像由 `.github/workflows/cds-sidecar-image.yml` 构建。我们能改它，只是它**不随分支预览自动部署**（需 CI 构镜像 + 共享边车池重部署），这是「部署门槛」不是「不可改」。

### 6.2 #3 慢首字（等 40s 才出字 / 思考不显示）根因与修法

根因（对照 `.claude/rules/llm-gateway.md` §2/§3）：用户用 OpenRouter 跑 deepseek-v3.2，OpenRouter 默认**不转发 reasoning**，把推理 hold 到结束才 flush content → 表现为「等 40 秒空白」。且边车两条上游链路都把思考增量丢弃。

四层打通 thinking（commit 718a719 + 326892d）：
- **边车** `agent_loop.py`：raw-anthropic 识别 `thinking_delta`；openai-compatible(OpenRouter) 请求体加 `include_reasoning:true` + `reasoning.exclude:false`，解析 delta 的 `reasoning`/`reasoning_content` → emit `thinking` 事件。`sdk_events.py`（官方 SDK 路径）映射 thinking 块。
- **CDS 平台** `remote-hosts.ts`：透传 `thinking` 事件给 MAP。
- **MAP** prd-api：`SidecarEventType`/`InfraAgentRuntimeEventType`/`InfraAgentEventTypes` 三处枚举补 `Thinking`；`ClaudeSidecarRouter.MapType` 识别字符串；`SidecarRuntimeAdapter` 映射；direct-sidecar 路径 switch 落 thinking 事件（不计入 finalText）；CDS-managed 路径本就按 type 透传。
- **前端** `CdsAgentPage.tsx`：聚合 `thinking` 事件在「Agent 思考中」气泡逐字展示。

### 6.3 本轮可验证层的视觉证据（预览域名真人路径，Playwright）

预览：`https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org/cds-agent`

PROBE（DOM 取证）：
```
hasTextarea=true  placeholder="在此输入你的问题，回车发送（无需先填仓库）"
hasModelPicker=true   hasNoiseBubble=false   自动捕获 P0=0
```
截图佐证：
- 落地页：引导空状态「想让 Agent 做什么？」+ 干净真输入框 + 模型选择器(deepseek/deepseek-v3.2 可下拉改) + 简洁右栏「运行进展」。证 #1/#2/#9/#10/#12/#13。
- 真实对话：发「请用三句话介绍你能做什么」→ Agent 8s 内 markdown 渲染回复并**干净收尾**（无工具循环/日志刷屏）。证 #5/#11，本轮观测 #7/#8 未复现。

### 6.4 部署门槛（thinking 上线的唯一未完成步骤，需有人值守）

可验证层（prd-admin + prd-api，随分支预览自动部署）：**已上线已验**。
边车层（thinking 真正产生 reasoning 事件）需共享基础设施重部署，属有 blast radius 的操作，按 `blocked-state-circuit-breaker.md` 不在无人值守时执行：
1. 边车镜像：**已构建成功**（CI run 27090697560，SHA 326892d，已推 ghcr）。
2. 待执行（值守）：共享边车池重部署到新镜像 + CDS 平台 `cdscli update --branch` 自更新。回滚：重部署回上一镜像 tag。

> 结论：thinking 代码四层全部写完并推送、镜像已构建；剩一步「共享边车池重部署」需有人值守执行（误则影响所有人的 CDS Agent），不在熟睡时擅自动共享设施。

---

## 7. 全面体验审查（/human-verify · 2026-06-07，AI 主动找全）

> 背景：用户反复「报一个修一个」，正确角色是产品负责人不是 QA（违反 CLAUDE.md §8.1）。本节是 AI 用 human-verify 用户场景模拟 + 代码逆向，一次性把简洁模式所有体验问题找全，按严重度 + 状态登记。状态：已修验=预览已验 / 已修待部署=代码推了等分支构建 / gated=边车层需共享重部署 / 待办 / 设计待定。

### A 会话生命周期（最严重）
| # | 问题 | 严重 | 状态 | 根因/修法 |
|---|---|---|---|---|
| A1 | 发请求后历史消失 + 列表全是「新会话 已超时」 | P0 | 已修验(多轮脚本 HISTORY_PRESERVED=true) | done 后会话从不转终态→停留 running 直到超时;下次发送 activeSessionTimedOut→新建会话→历史丢。修:CDS-managed+direct 两路径 done→idle(不计超时、可复用),追问复用同会话 |
| A2 | 多轮上下文:追问只发新消息,不回灌历史→agent 不记得上文 | P1 | 待办 | 需后端把会话历史拼进发给 agent 的 messages |

### B 流式与延迟（边车层）
| # | 问题 | 严重 | 状态 | 说明 |
|---|---|---|---|---|
| B1 | 假流式:内容憋到 ~50s 末尾一次性吐 | P0 | gated | OpenRouter 把 reasoning 憋到结束才 flush;修法(include_reasoning+解析 reasoning 增量)已推,需边车重部署 |
| B2 | 对话模式仍调工具(工具阶段 ~26s) | P1 | gated | 对话模式应不暴露工具;收敛改动在边车/prompt 层 |
| B3 | 等待文案一上来就吓人 | P2 | 已修 | ≥15s 才提示「推理较慢」 |

### C 发送中间态
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| C1 | 发送后消息闪一下消失再出现 | P0 | 已修验(100ms 高频取证 firstBubble=0/丢失=0) |
| C2 | 输入框发送后从中间跳到底部 | P1 | 已修验 |
| C3 | 「正在发送任务/复制诊断」开发者卡噪音 | P2 | 已修(仅失败显示) |
| C4 | placeholder 写「回车发送」但回车不发送(无 onKeyDown) | P1 | 已修验 |

### D 输入框与布局（借鉴 Codex）
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| D1 | 输入框拆分臃肿(顶部 tab 行+分隔线+提示+宽发送钮) | P1 | 已修验(融合一行+圆形箭头) |
| D2 | 右栏固定占宽,内容区显小 | P2 | 已修验(可折叠) |
| D3 | 选中高亮走内层 textarea 而非外层容器 | P2 | 已修(focus-within 落外框) |
| D4 | 刷新后 ~10s 空白无反馈 | P1 | 已修(MapSectionLoader 加载态) |

### E 渲染
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| E1 | 流式期裸 markdown(**),结束啪一下变样 | P1 | 已修验 |
| E2 | 右栏「1个产物/N个事件」噪音 | P2 | 已修 |
| E3 | 空 payload 事件展开为空 | P2 | 已修 |
| E4 | 内部状态/日志气泡污染对话流 | P1 | 已修 |

### F 配置/模型
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| F1 | 刷新卡「请先同步系统主模型」三连 | P1 | 已修(自动启用默认) |
| F2 | 模型不可见/不可改(配 v4 跑 v3.2) | P1 | 已修(输入栏模型选择器) |
| F3 | 「同步系统主模型」文案困惑 | P2 | 已修 |

### G 思考可见性
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| G1 | 推理思考过程不显示 | P1 | gated(四层 thinking 已推,需边车重部署) |

### H 架构方向（用户点2）
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| H1 | GitHub 地址当基础设施(且后续步骤没做完) | P1 | 设计待定:改「文件夹/知识库当工作区基础设施,GitHub 仅钩子」;真正挂载需 workspace 注入(path-1),与边车同 gated |

### I 列表/命名（次要）
| # | 问题 | 严重 | 状态 |
|---|---|---|---|
| I1 | 「+」新建无 prompt 时叫「新会话」未命名 | P3 | 待办(首条消息后回填标题) |

### 结论
- P0 共 3 个(A1/B1/C1):C1 已修验;A1 已修待部署;B1 gated。
- 自修可验证层(C/D/E/F + A1 前端表现)基本清完;**剩余全部卡在同一道闸:边车/CDS 共享池重部署**(B1/B2/G1)+ 一个架构决策(H1)+ 两个待办(A2/I1)。
