| feat | cds | 新增 `PendingImportInbox` 全局组件:右下角浮动徽章 + 抽屉,任何页面都能看到 agent 提交的待审批 cds-compose 申请,一键批准/拒绝。事件驱动(订阅 `pending-import.*`),不再 10s 轮询。挂在 AppShell 与 OperatorApprovalModal 同层,用户不再需要 AI 给地址才能打开审批面板 |
| feat | cds | `useCdsEvents` hook 订阅新增 `pending-import.created/decided/count` + `infra.flap.circuit-breaker` 事件,在 store 中暴露 `lastPendingImportEvent` / `lastFlapEvent`,供 UI 组件响应 |
| feat | cds | infra flap 熔断告警自动在右下角持久 toast:容器名 + RestartCount + dismiss 按钮。用户能立刻知道是哪个 yaml 配置错引起的 |
