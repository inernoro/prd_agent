| feat | cds | Phase 9.1 EnvSetupDialog 必填密钥旁加「生成」按钮(crypto.getRandomValues + base64url 24 字节,等价 cdscli token_urlsafe(24)),一键填充 + 自动 reveal |
| feat | cds | Phase 9.2 EnvSetupDialog 顶部加「上传 .env」按钮,支持 KEY=VALUE 批量填充(覆盖现有 + 新增,带 N 项匹配反馈) |
| feat | cds | Phase 9.3 ProjectSettingsPage 项目环境变量 tab 加「打开向导」入口,用户后续可重新打开 EnvSetupDialog 三色分组弹窗 |
| feat | cds | Phase 9.4 EnvSetupDialog 密钥字段(SECRET / PASSWORD / TOKEN / KEY / PRIVATE 命中)默认 type=password 脱敏,加 Eye/EyeOff 按钮 reveal |
| feat | cds | Phase 9.5 env 修改审计日志:Project.envChangeLog ring buffer ≤ 200,记 op + keys(不记 value 防泄漏)+ actor + source。PUT /env / PUT /env/:key / DELETE /env/:key 自动追加,GET /api/env/audit?scope=<projectId> 读取 |
| feat | cds | Phase 9.6 BranchListPage 顶部加「必填环境变量缺失,deploy 会被 block」rose-color banner,点「立刻填写」直跳 /settings/:projectId#env;比 pendingEnvKeys 的 TODO 占位检测更准(读后端 envMeta) |
| test | cds | env-audit-phase9.test.ts 5 case(append + ring buffer + 项目隔离 + 不存在项目 noop + ts 自动加),vitest 956 全绿 |
