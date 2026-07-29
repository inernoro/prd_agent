| polish | prd-admin | 重做视频创作交互 Demo、可视化生成进度与系统自适应分镜工作台 |
| fix | prd-admin, prd-api | 修复视频生成假死反馈、单镜时长与模型能力不匹配及失败原因不可见问题 |
| fix | prd-admin | 修复真实镜头提交后因首次状态回读陈旧而停止轮询、页面持续显示旧错误的问题 |
| fix | prd-api, prd-admin | 修复共享数据库下多个视频 worker 重复领取同一镜头、一次点击生成多个上游任务的问题 |
| fix | prd-api, prd-admin | 修复并发重试覆盖领取标记、worker 重启后镜头永久卡住、恢复轮询模型漂移及历史成本低报问题 |
