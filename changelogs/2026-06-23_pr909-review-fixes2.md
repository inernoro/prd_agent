| fix | cds | 项目迁移 Tab 防跨项目串显:projectId 切换即清空残留 + 慢响应 stale-guard 丢弃,避免别项目 cds-compose(含明文 env)被旧响应覆盖显示(PR #909 Bugbot High) |
| fix | cds | 项目迁移 Tab 加载失败不再无限转圈:loadPeers 出错/网络异常时 setPeers([]) 退出 loading,渲染空状态而非永久「加载迁移设置…」(PR #909 Bugbot) |
