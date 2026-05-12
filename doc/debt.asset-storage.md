# debt.asset-storage

| 字段 | 内容 |
|---|---|
| 模块 | 资源存储（IAssetStorage 实现） |
| 状态 | 活跃 |
| 关联 | `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/` |

---

## 已知工程债务

| ID | 说明 | 优先级 | 触发条件 | 状态 |
|---|---|---|---|---|
| S-1 | `LocalAssetStorage` / `TencentCosStorage` / `CloudflareR2Storage` 三套实现里 `ResolveExtension` / `SanitizeExt` / `MimeToExt` / `ExtToMime` 完全复制粘贴。下一次扩 mime 映射或修通用 bug 都得三处同步——本次 PR 第一轮就是因为只改了 Local 没改 COS/R2 才反复出问题。建议抽到 `AssetStorageExtensions.cs` 静态工具类，三处 internal `using static` 引用。 | **P2** | 下次新增 mime 映射 / 又被同样 bug 咬一次 | new (PR #542 引入) |
| S-2 | 历史已经存为错误后缀的对象（COS/R2 上无数 `.png` 实际是 m4a/mp3/zip）需要数据迁移：扫 `attachments` / `documententries` / `image_assets` 等集合，按 `ContentType` 推断真实后缀，把 `Url` 字段重写并迁对象 key。否则旧数据永远播放不了波形（CDN 仍按 png 处理）。 | **P2** | 用户对老旧文档发起字幕/再加工/外部 share 时 | new |
| S-3 | 知识库历史数据全 fallback 到 `.png`，CDN 配置 `Access-Control-Allow-Origin` 后 wavesurfer 仍然不能 decode 这些"假装是 png 实际是 m4a" 的文件（mime 不对）。需要 S-2 完成后才能修复。 | P2 | S-2 完成 | blocked-on-S-2 |

---

## 跨模块债务（在 PR #542 review 中被发现，但不属于本 PR scope）

| ID | 说明 | 文件 | 优先级 | 触发条件 |
|---|---|---|---|---|
| X-1 | `SubtitleGenerationProcessor.cs` 的 `doubao-asr` 异步分支曾传空 `multipartFields`，且参考实现 `TranscriptRunWorker.ProcessAsrViaGatewayAsync` 始终包含 `model / response_format / timestamp_granularities[] / language`。Gateway Exchange 路径只把 multipart 文件转成 `image_urls`，而 `DoubaoAsrTransformer.TransformRequest` 只读 `audio_url / audio_data / url`，因此该路径不能走 multipart files。当前代码已改为 JSON `audio_data(base64)`，并用 `SubtitleGenerationProcessorTests.DoubaoAsyncAsr_ShouldSendAudioDataJson_NotMultipart` 锁定回归。 | `prd-api/src/PrdAgent.Api/Services/SubtitleGenerationProcessor.cs` | **P1** | 已还债：2026-05-12 |
| X-2 | `ExchangeController.cs` SSE error 事件曾直接把 `ex.StackTrace` 前 3 行 + `ex.GetType().Name` + raw `ex.Message` 推给客户端，泄露后端实现细节（文件路径、类名、方法签名）。当前已改成客户端只收到友好 message、`errorCode`、`requestId`、`exchangeId`，完整异常仅通过 `LogError` 写服务端日志。 | `prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs` | **P2** | 已还债：2026-05-12 |
| X-3 | 前端 `AsrDiagnostic` 类型 + `DiagnosticBlock` / `KV` helper 在 `SubtitleGenerationDrawer.tsx` 与 `ExchangeTestPanel.tsx` 两处复制。后端加 diagnostic 字段需双改。抽到 `prd-admin/src/components/exchange/AsrDiagnosticBlock.tsx` 共享。 | `prd-admin/src/pages/document-store/SubtitleGenerationDrawer.tsx` + `prd-admin/src/components/exchange/ExchangeTestPanel.tsx` | P3 | 后端字段变更 |
| X-4 | `DocumentStoreAgentWorker.cs:154-157` 错误消息+诊断 JSON 拼接后用 `combined[..1500]` 截断，可能切断 JSON 字符串中段。前端 `refreshRun` fallback 拿到带 `[diagnostic]` 标记的字符串后 `JSON.parse` 失败→诊断面板丢失。修法：截断前先做 `JsonNode.Parse` 取字段值优先丢弃 `redactedBody` / `rawSnippet` 等大字段，不要在 JSON 中段切。 | `prd-api/src/PrdAgent.Api/Services/DocumentStoreAgentWorker.cs` | P3 | 错误消息很长（>1500 字符）的极端场景 |
| X-5 | `ExchangeController.cs` ASR 失败时后端先发 `result` event（含 text/segmentCount/durationMs/diagnostic），紧接着为兼容老前端再发 `error` event。前端 `ExchangeTestPanel.tsx` 的 error handler 曾把 `sseResult` 覆盖为 `text:''/segmentCount:0/durationMs:0`，把 result event 携带的部分转录数据丢光。当前已改为保留已有 `text/segmentCount/durationMs`，只追加 error message，并补充前端单测锁定。 | `prd-api/src/PrdAgent.Api/Controllers/Api/ExchangeController.cs` + `prd-admin/src/components/exchange/ExchangeTestPanel.tsx` | P3 | 已还债：2026-05-12 |

---

## 历史背景

- 2026-05-08 PR #542 第一轮修复"知识库 m4a 被存成 .png" — 我先只补 `LocalAssetStorage.MimeToExt` 白名单，没看到 COS/R2 也是同样代码 → 用户反馈"反反复复"。第二轮根治用 `ResolveExtension` 优先 fileName + 默认 `.bin` 兜底。
- Cursor Bugbot 在第二轮 commit `9253b0f` 上的 review 提醒了 S-1/S-2/X-1/X-2/X-3 全部 5 条，本文档登记其中本 PR scope 外的 4 条（X-1/X-2/X-3 + S-1/S-2 因牵涉迁移脚本也单独立项）。

## 还债记录

| 日期 | ID | 处理结果 | 验收 |
|---|---|---|---|
| 2026-05-12 | X-1 | 确认 `SubtitleGenerationProcessor` 已走豆包异步 JSON `audio_data(base64)` 路径，不再把音频作为 multipart 文件传给 Exchange；补充回归测试防止退回空 body/multipart 路径。 | `dotnet test --no-restore --filter SubtitleGenerationProcessorTests` |
| 2026-05-12 | X-2 | Exchange ASR SSE 控制器异常不再把 raw exception、异常类型和 stack 下发给客户端；服务端日志保留完整异常，前端用 `requestId` 对齐排查。 | `dotnet test --no-restore --filter ExchangeControllerTests` |
| 2026-05-12 | X-5 | Exchange Test Panel 收到 SSE `error` 事件时不再清空此前 `result` 事件带来的转写文本、段数、耗时和诊断信息。 | `pnpm test -- ExchangeTestPanel.test.ts` |
