| fix | prd-api | 视频 Agent 直出模式：上传文件/粘贴文本时自动从 articleMarkdown/附件提取作为 directPrompt，不再因 prompt 为空创建失败 |
| fix | prd-api | 视频 Agent Remotion 单镜渲染加 5 分钟超时 + 失败原因落到 scene.ErrorMessage（含 stderr/stdout 摘要），避免 Worker 挂死和"渲染失败"无原因可查 |
| fix | prd-api | 视频 Agent 单镜直出失败时 errorMessage 持久化到分镜，刷新页面后仍能看见原因（之前只走 SSE 一次性事件） |
| fix | prd-api | 视频 Agent 修复 OpenRouter 提交后 DirectVideoModel 被无条件回写导致的"粘性 per-scene 覆盖"，仅在用户已显式选择时才回写 |
| fix | prd-api | 视频 Agent applyToAll 切换默认模式时改为清除所有 per-scene RenderMode 覆盖（设 null），与"已存在的单镜模式覆盖会被清除"UI 文案一致 |
| fix | prd-api | 视频 Agent 最终导出加守卫：检测到混合模式（部分分镜走 Remotion + 部分走直通大模型）时显式失败而非静默丢掉直出场景，错误信息含具体分镜编号 |
| fix | prd-admin | 视频 Agent 直出模式 chip 选择 + 上传文件时也把 articleMarkdown/attachmentIds 一起传给后端，让后端兜底生成 prompt |
| fix | prd-admin | 视频 Agent 修复 run.renderMode='videogen' 但有分镜时被 VideoGenDirectPanel 抢占场景编辑器的 bug，仅在 scenes 为空时才视为单镜直出任务 |
| feat | prd-admin | 视频 Agent 进入页面自动选中"最值得继续的"任务（进行中优先 > 最近完成）+ selectedRunId 持久化到 sessionStorage，告别"每次进来空白要重新开始"的体验 |
| fix | prd-admin | 视频 Agent 分镜模型下拉去重：原本同一模型 id 在 VIDEO_MODEL_TIERS 和 OPENROUTER_VIDEO_MODELS 两边各出现一次，下拉里有重复项 |
