| security | claude-sdk-sidecar / prd-api | 将 Sidecar 运行、工具审批与取消绑定短期任务授权，拒绝调用者扩权、越界路径及审批重放；保留隔离与多副本边界 |
| security | prd-api | 运行与审批转为 Mongo 持久原子消费，拒绝重启及跨进程重放、过期和存储故障；跨副本取消与 OS 隔离仍待验收 |
| security | sidecar / prd-api | 共享持久取消状态并绑定主体和运行，原子保持终态；控制面故障停止执行且报告未确认，保留真实 SDK/OS 验收边界 |
