| fix | prd-admin | 视频 Agent 自动恢复任务时，sessionStorage 里 stale runId 已被删除/过期的情况下不会再卡住，会继续 fallback 选最近一条任务（之前 ref 提前置 true 把回退分支拦了） |
| fix | prd-api | 视频 Agent 导出守卫修正：所有分镜都通过 per-scene 覆盖切到「直通大模型」时也会显式失败，不再静默走 Remotion 拼接产出空视频 |
| fix | prd-api | 视频 Agent 分镜级 RenderMode 加白名单校验，与 run 级别保持一致；客户端传错字（如 "vidogen"）直接报错而非默默落库 |
