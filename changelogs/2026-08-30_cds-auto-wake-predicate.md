| fix | cds | 预览自动唤醒判据从只认 scheduler 放宽到「CDS 自己决定的停机」，容器还在的分支不再永久 503 |
| refactor | cds | 唤醒判据抽成唯一判定源 branch-wake-eligibility.ts，proxy 与 index 两份拷贝合一；删除意图标记同处收敛 |
| test | cds | 新增 28 项判据测试（十种停机来源逐档 + 删除意图 + 远端执行器 + 空 services + 分裂守卫） |
