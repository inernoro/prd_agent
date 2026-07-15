# 视频生成 Agent 债务台账

> **版本**：v3.0 | **日期**：2026-07-13 | **状态**：维护中

## 当前架构

视频创作支持两条正式路径：

1. 直出模式：提示词或首帧图片经 LLM Gateway 路由到视频模型，异步提交、轮询、下载并保存到资产存储。
2. 分镜模式：文学稿经聊天模型拆分为镜头，用户在制作台逐镜编辑、批量生成、保留历史版本，最后由 ffmpeg 统一画幅和编码并合成为完整 MP4。

火山方舟 Seedance 通过 `volcengine-video` Exchange 转换器适配原生异步任务协议。OpenRouter 兼容协议仍由原视频客户端处理，两者共用 `video-agent.videogen::video-gen` 调用方和模型池治理。

## 已完成

| ID | 状态 | 结果 |
|----|------|------|
| professional-console | paid | 四区制作台：镜头与版本、中央播放器、镜头控制器、多轨时间线 |
| scene-version-history | paid | 重新生成不覆盖旧视频，可切换采用版本 |
| batch-render | paid | 批量提交未完成和失败镜头，Worker 顺序执行并持续推送事件 |
| full-export | paid | ffmpeg 统一画幅、帧率和编码，合成后上传资产存储 |
| export-recovery | paid | 导出失败回到编辑态，可修改和重试；导出后继续编辑会使旧成片失效 |
| seedance-protocol | paid | 火山 Seedance submit、status、download 协议转换已有自动化回归 |

## 未完成边界

| ID | 优先级 | 触发场景 | 当前行为 | 后续方案 |
|----|--------|----------|----------|----------|
| audio-subtitle-tracks | high | 需要配音、音乐、字幕和转场 | 制作台显示音频轨道但明确标注尚未接入；当前分镜生成关闭音频，导出只合成视频轨 | 复用现有 TTS、字幕与 ASR 能力，新增音频资产和时间线片段，再扩展 ffmpeg filter graph |
| scene-reference-controls | high | 需要角色一致性、首尾帧和参考素材 | 直出支持首帧图；分镜控制器暂未暴露镜头级参考资产 | 为 VideoGenScene 增加受模型能力约束的参考资产字段，并由 Gateway 返回 capability schema |
| project-run-separation | medium | 一个项目产生大量生成尝试和多条时间线 | 当前仍以 VideoGenRun 兼容承载项目和任务，镜头版本嵌入文档 | 使用真实生产数据确认粒度后，再拆分 VideoProject、GenerationAttempt 和 ExportRun，避免提前迁移线上集合 |
| model-capability-schema | medium | 不同视频模型支持不同参数 | 前端展示公共参数，模型特有控制暂不出现 | 由模型池 API 返回视频 capability schema，控制器按后端描述渲染 |
| upstream-availability | critical | 正式模型余额、授权或渠道变化 | 代码和协议可用不等于上游随时可用；模型池健康状态仍是最终权威 | 正式发布前运行 scoped video canary，失败时阻止提交并展示供应商健康原因 |

## 验收约束

- 不以 API 返回成功代替视频产物验收。
- 正式闭环必须覆盖提交、轮询、下载、资产保存、分镜合成和公开播放。
- 生产 canary 必须限制视频提交数量，避免重复生成造成真实费用。
- 音频、字幕和模型特有能力未接入前必须在界面明确展示边界，不允许静默假装可用。
