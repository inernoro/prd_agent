| feat | cds | Phase 8 — env 三色契约 + 强制配置弹窗 + 行云流水部署:导入项目即引导用户填必填项,配完自动跳分支页 + 部署 |
| feat | cds-skill | Phase 8.1 cdscli scan 输出 x-cds-env-meta 段(每 env 标 kind=auto/required/infra-derived + hint),自动从应用 service env 引用的 ${VAR} 识别用户必填密钥(SMTP/OAUTH 等) |
| feat | cds | Phase 8.2 BuildProfile 旁挂 EnvMeta 类型;Project 加 envMeta + defaultEnv 字段;compose-parser 读 x-cds-env-meta 段(kind 大小写不敏感,未知值兜底为 auto);PendingImport.summary 暴露三色分类 |
| feat | cds | Phase 8.3 POST /branches/:id/deploy 检测 envMeta 中 required 项是否全填,缺失返回 412 Precondition Failed + missingRequiredEnvKeys + hints,?ignoreRequired=1 query 提供降级逃生口 |
| feat | cds | Phase 8.4 Project.defaultEnv 模板化:GET /env 项目级 scope 同时返回 envMeta + missingRequiredEnvKeys;PUT /env 同步写 customEnv + defaultEnv;新分支创建时自动从 defaultEnv 继承(避免每个分支重填 SMTP) |
| feat | cds | Phase 8.5 EnvSetupDialog 组件:clone 完成后自动弹窗,顶部"必填项"输入区(amber 强调) + "CDS 自动生成"折叠区 + "基础设施推导"折叠区,必填全填才 enable「完成,开始部署」按钮 |
| feat | cds | Phase 8.6 行云流水:env 配完跳转 /branches/:projectId,sessionStorage 信号触发自动部署默认分支(default → 第一个),用户从导入到第一个分支起来零手工 |
| feat | cds | Phase 8.7 docker-compose.yml 直接消费:即使没 cds-compose.yml,只要 docker-compose 含相对 mount 就当 CDS Compose 解析,用户带原项目过来不强制先生成 cds-compose.yml |
| test | cds | env-meta-phase8.test.ts(6 case)+ env-meta-state-phase8.test.ts(9 case);test_env_meta_phase8.py(6 case)。共 21 个 Phase 8 新单测全绿,cds 后端 951 全绿,pytest 20 全绿 |
| docs | cds | plan.cds-mysql-readiness.md § 五 加 Phase 8 ✅ 一行 |
