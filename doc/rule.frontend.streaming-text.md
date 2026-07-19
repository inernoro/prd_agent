# 流式文本动效 · 规则

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

`prd-admin` 的 LLM 增量文本统一使用共享流式组件和 SSE 基础设施。页面不得自行实现打字计时器、闪烁光标或逐块 Markdown 重渲染。

## 1. 强制行为

- 增量正文和思考文本使用 `StreamingText`。
- 流式期间使用轻量纯文本动效，完成后再切换完整 Markdown 渲染。
- 一次性 AI 端点优先升级为 SSE，并使用共享预览弹窗与流式 Hook。
- 用户取消只触发明确的取消语义，不能把页面卸载等同于服务端任务取消。
- 错误、阶段、模型信息和最终正文分别处理，不混成文本前缀。

## 2. 共享事实源

| 能力 | 位置 |
|---|---|
| 文本动效 | `prd-admin/src/components/streaming/StreamingText.tsx` |
| 光标 | `prd-admin/src/components/streaming/MapCursor.tsx` |
| AI 预览弹窗 | `prd-admin/src/components/ai-preview/AiPreviewModal.tsx` |
| 前端流式状态 | `prd-admin/src/hooks/useAiPreviewStream.ts` |
| 后端 SSE 写入 | `AiStreamingHelpers.WriteSseStreamAsync` |

使用方式只需传入累计文本和是否仍在流式中：

```tsx
<StreamingText text={text} streaming={streaming} markdown />
```

特殊模式或自定义光标必须有明确产品理由，并继续复用共享组件。

## 3. SSE 事件职责

| 事件 | 用途 |
|---|---|
| `status` | 当前阶段和可读提示 |
| `thinking` | 模型支持时的思考增量 |
| `content` | 最终正文增量 |
| `model` | 实际模型信息 |
| `done` | 完成与最终元数据 |
| `error` | 可恢复或终止错误 |
| `heartbeat` | 保持连接和识别断连 |

页面应按事件更新共享状态，不自行解析混合文本协议。

## 4. 禁止事项

- 用 `setInterval` 或 `setTimeout` 模拟模型输出。
- 每个 chunk 都执行完整 Markdown 高亮和布局。
- 裸 `pre` 长时间展示静止文本。
- 在多个页面复制 SSE parser。
- 流结束后仍显示活动光标。
- 用静止的“加载中”替代真实阶段和进度。

## 5. 验收

- 首个响应前持续展示阶段反馈。
- 增量内容平滑追加，不反复跳动或重置。
- 完成后 Markdown、复制和选择文本正常。
- 取消、断网、服务端错误和模型未绑定均有明确状态。
- 页面刷新后的服务端任务状态可恢复。
- 类型检查、相关测试和至少一条浏览器路径通过。

具体属性和事件类型以共享组件及 Hook 的源码为准。
