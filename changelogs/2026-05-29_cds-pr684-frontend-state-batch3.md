| fix | cds | 待审批导入抽屉:审批前对每条拉单条 detail 补回 composeYaml(列表端点刻意 strip),操作员不再盲批 agent 提交的 profile/infra/env(Codex P2) |
| fix | cds | operator 审批弹窗实时刷新:useCdsEvents 订阅 operator.request.* 事件并入 store,弹窗据此秒级刷新,不再最多隐身 25s 等 heartbeat(Codex P2) |
| fix | cds | self-status-cache 刷新合并补队列:运行中再被请求时标脏,当前 job 跑完补跑一次,防止 self-update 收尾的最终状态变化被吞、浏览器卡在 updating(Codex P2) |
