| feat | cds | 波5 已 clone 空项目事后栈检测:GET /api/projects/:id/detect-preview(只读扫 worktree)+ POST detect-apply(用户确认后建构建配置,空项目守门,race-free) |
| refactor | cds | 抽出 buildDetectedServicesFromDir 共享检测逻辑,detect-runtime 复用(去重) |
