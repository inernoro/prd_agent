| fix | cds | 修复 [项目环境变量] /api/branches/:id/effective-env 返回 secret 明文导致网络面板/截图泄露(Bugbot Medium):服务端默认 redact secret 值为 "••••" + 末 4 位,新增 GET /api/branches/:id/effective-env/reveal?key=X 端点按需取明文,前端 reveal/复制按钮改走该端点 |
| fix | cds | 删除 /effective-env 里 dead code 的 customEnv = stateService.getCustomEnv(projectId) 调用(Bugbot Low):Round 1 改 source 推断后这个 flat merge 已不再被读 |
