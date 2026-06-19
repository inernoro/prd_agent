| fix | prd-api | 额度判定排除限流误报：429 / "Rate limit exceeded" / "requests per minute" 等节流不再被当成额度用尽（LLM_QUOTA_EXCEEDED 误触发额度告警）；额度只认 key/credit/quota/balance/billing 明确信号 |
| fix | prd-admin | 视觉分镜台并发竞态修复：每轮「生成分镜」自增 genRef 作废上一轮在途关键帧 SSE 与图生视频轮询（stale-response guard），旧回调不再画到新分镜板同 sceneIndex；创建关键帧任务无 runId 时复位 spinner 为 error；同镜正在转视频时禁止重复触发「动起来」 |
