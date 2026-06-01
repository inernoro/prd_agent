# 文档再加工 · 智能体调用路由设计

> **状态**: 已实现 (claude/loving-noether-eCZVo)
> **覆盖范围**: 知识库再加工 Chat 抽屉里的 3 种智能体调用方式如何收敛到统一的 LLM 链路。

## 1. 管理摘要

知识库「文档再加工」抽屉的智能体调用分 **3 个入口、1 条管道、1 个落库口**。所有智能体调用统一走百宝箱的 `POST /api/ai-toolbox/direct-chat` SSE 接口，区别只在"系统提示词从哪里组装"。回包是同一份 SSE 协议（`start` / `text` / `thinking` / `error` / `done`），落库走同一个 `POST /entries/{id}/reprocess/apply-content`。

## 2. 调用图（架构总览）

```
┌──────────────────────────────────────────────────────────────────────┐
│                      文档再加工 · Chat 抽屉                          │
│                                                                      │
│   ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐         │
│   │ 百宝箱内置   │  │ 百宝箱自建   │  │ 我的快捷智能体     │         │
│   │ (BUILTIN)    │  │ (toolbox     │  │ (DB 中的轻量       │         │
│   │ 比如        │  │  item.id)    │  │  system prompt)    │         │
│   │ literary-    │  │              │  │                    │         │
│   │ agent        │  │              │  │                    │         │
│   └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘         │
│          │                  │                    │                    │
│          │ agentKey         │ itemId             │ 不传 agentKey      │
│          │                  │                    │ /itemId            │
│          │                  │                    │                    │
│          │                  │              system prompt 拼到 message │
│          ▼                  ▼                    ▼                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │   POST /api/ai-toolbox/direct-chat (SSE)                     │   │
│   │   body: { message, agentKey?, itemId?, history? }            │   │
│   │   message = [智能体角色设定]?\n[参考文档]\n[用户指令]        │   │
│   └──────────────────────────────┬───────────────────────────────┘   │
│                                  │                                    │
│                                  ▼                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │  AiToolboxController.DirectChat (后端组装 system prompt)     │   │
│   │  ┌───────────────────────────────────────────────────────┐   │   │
│   │  │ itemId  → item.SystemPrompt + EnabledTools +           │   │   │
│   │  │           KnowledgeBaseIds 注入                        │   │   │
│   │  │ agentKey → GetBuiltinAgentSystemPrompt(key) 硬编码映射 │   │   │
│   │  │ 都没传  → 通用 chat prompt                             │   │   │
│   │  └───────────────────────────────────────────────────────┘   │   │
│   └──────────────────────────────┬───────────────────────────────┘   │
│                                  │                                    │
│                                  ▼                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │       ILlmGateway (compute-then-send, 单次 Resolve)          │   │
│   │       AppCallerCode = ai-toolbox.agent.{key}::chat           │   │
│   └──────────────────────────────┬───────────────────────────────┘   │
│                                  │                                    │
│                                  ▼                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │  OpenRouter / 自有 LLM 平台 (流式 SSE)                       │   │
│   └──────────────────────────────┬───────────────────────────────┘   │
│                                  │                                    │
│      SSE 事件流回传:  start → (thinking)* → text* → done             │
│                                  │                                    │
│                                  ▼                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │       抽屉渲染（StreamingText 流式动效 + Markdown）          │   │
│   └──────────────────────────────┬───────────────────────────────┘   │
│                                  │                                    │
│              用户点击「替换原文 / 追加末尾 / 另存为新文档」          │
│                                  │                                    │
│                                  ▼                                    │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │  POST /entries/{id}/reprocess/apply-content                  │   │
│   │  body: { mode: replace|append|new, content, title? }         │   │
│   │  内部复用 ContentReprocessApplyService（无 Run 依赖）        │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. 三种类型的最小差异

| 维度 | 百宝箱内置 | 百宝箱自建 | 我的快捷智能体 |
|------|------------|------------|----------------|
| 注册位置 | `BUILTIN_TOOLS` 前端 + `GetBuiltinAgentSystemPrompt` 后端硬编码 | `toolbox_items` 集合 | `reprocess_agents` 集合 |
| 标识符 | `agentKey` (e.g. `literary-agent`) | `itemId` (Mongo ObjectId) | 前端用 `key`；后端拼到 message 里 |
| System Prompt 来源 | `GetBuiltinAgentSystemPrompt(key)` 后端硬编码 | `item.SystemPrompt` 后端读 DB | 前端读 `agent.systemPrompt`，拼到 message 头 |
| 增强能力 | 无 | EnabledTools + KnowledgeBaseIds 注入 | 无（只是 prompt 覆盖） |
| AppCallerCode | `GetAgentAppCallerCode(key)` 后端按 key 映射 | `ai-toolbox.orchestration::chat` | 同上 |
| 用户创建 | 不可（系统内置） | 可（去 `/ai-toolbox` 页创建） | 可（在抽屉里浮层一键创建） |

## 4. 边界与异常路径

| 场景 | 处理 |
|------|------|
| 文档无正文 | 抽屉打开时 `getDocumentContent` 已经走过 fallback（DocumentId → ContentIndex），如果都空则消息流空状态展示 |
| 文档过大（>40KB） | 前端截断到前 40000 字符 + 提示「文档过长，已截取前 40000 字喂给 AI」 |
| 文件夹 entry | 上层 DocBrowser 不显示「再加工」按钮，进不来 |
| 流式中切换/再点 chip | `streamingId !== null` 时所有 chip / 输入框 disabled |
| 流式中关闭抽屉 | useEffect cleanup 调 `cancelStreamRef.current?.()` 中止 fetch |
| LLM 错误 | onError → 在最后一条 assistant 气泡里渲染失败原因 + 顶部红 banner |
| 多轮上下文 | 每次发送把全部历史 user/assistant 一并塞进 `history`，让 direct-chat 看到完整对话 |
| 删除自建快捷智能体 | confirm 后 DELETE，只允许删自己的（visibility=personal && OwnerUserId == userId） |

## 5. 关联文件

- 前端: `prd-admin/src/pages/document-store/ReprocessChatDrawer.tsx`
- 前端 service: `prd-admin/src/services/real/aiToolbox.ts` 的 `streamDirectChat` + `prd-admin/src/services/real/documentStore.ts` 的 `applyReprocessContent` / `listReprocessAgents`
- 后端: `prd-api/src/PrdAgent.Api/Controllers/Api/AiToolboxController.cs` `DirectChat` 端点 + `prd-api/src/PrdAgent.Api/Controllers/Api/DocumentStoreController.cs` `ApplyContent` 端点
- 后端模型: `prd-api/src/PrdAgent.Core/Models/ReprocessAgent.cs`
- 后端 Service: `prd-api/src/PrdAgent.Api/Services/ContentReprocessApplyService.cs` + `ReprocessAgentSeeder.cs`
