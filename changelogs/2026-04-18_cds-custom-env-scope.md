| feat | cds | customEnv 支持项目级作用域：{ _global, <projectId> }，部署时 project 覆盖 global，禁止跨项目泄漏 |
| feat | cds | /api/env 全部端点接受 `?scope=_global|<projectId>`，默认 _global 保持向后兼容 |
| feat | cds | 分支页环境变量弹窗新增"全局 / 此项目"切换开关 |
| fix | cds | 删除项目时级联清理其 customEnv 作用域 bucket |
| test | cds | custom-env-scope.test.ts 6 新测试（迁移 + 合并优先级 + 级联） |
