| ops | scripts | 新增 LLM Gateway 只读 rollout status 汇总脚本，统一输出 health、shadow coverage、planner 下一步和进度表，并由 readiness 执行多 cell 与 health gate 状态板自测 |
| ops | scripts | LLM Gateway rollout status 覆盖窗口行新增 `nextEligibleAt`，直接显示最早允许 window-extension 补样的 UTC 时间 |
| ops | scripts | ASR 与视频 canary 默认增加单次预算上限，防止生产验证误跑多个 caller/model 产生过量供应商费用 |
