| fix | prd-api | 注册更新中心 AI 总结的 AppCallerCode（prd-admin.changelog.ai-summary::chat），修复点击「AI 总结」报「appCallerCode 未注册」的运行时错误 |
| fix | prd-api/tests | 加强 AppCallerCodeRegistryGuardTests 正则覆盖 camelCase 字面量并新增 kebab-case 命名规范测试，防止再次出现 #504 那种用 camelCase 绕过守卫的情况 |
