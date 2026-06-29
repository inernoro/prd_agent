| feat | cds | 新增任务调度 MVP，支持项目级定时任务、手动执行、HTTP/命令目标和运行记录 |
| feat | cds | 任务调度动作支持检测执行与 curl 导入，并补充多组解析和检测测试 |
| security | cds | 任务调度命令动作改为 Docker sandbox 执行，隔离宿主文件系统并限制工作目录逃逸 |
| feat | cds | 任务调度改为触发器加动作步骤的纵向配置流，支持多个动作按顺序执行 |
| security | cds | 修复项目级 key 可无范围读取任务调度列表与运行日志的问题 |
| fix | cds | 任务调度执行时按 retryCount 重试失败动作 |
