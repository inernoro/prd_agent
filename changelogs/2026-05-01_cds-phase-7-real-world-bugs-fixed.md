| feat | cds | Phase 7 — 9 个真 bug 全修(B9 已修 + B9.1-B17 本次):Twenty CRM 端到端跑通,Nest application successfully started + http 200 |
| feat | cds | B10 BuildProfile.entrypoint + container.ts docker run --entrypoint(支持预构建镜像清空 wrapper ENTRYPOINT,Twenty 用) |
| feat | cds | B11 ReadinessProbe.noHttp + container.ts waitForReadiness 跳过 HTTP probe(后台 worker / job runner 不监听 HTTP);compose label `cds.no-http-readiness` 触发 |
| feat | cds | B12 deploy 路由起完 infra 后等所有 healthcheck 配置的 infra healthy(60s 超时不阻塞;Twenty server entrypoint 假定 db service_healthy) |
| feat | cds-skill | B13 cdscli 不 rename infra service 名,保留用户原 service name(避免引用断,如 `db` 引用不到) |
| feat | cds | B14 PUT /api/env 同时接受 body.scope 和 ?scope= query;剔除 scope 元字段不污染 env(避免被当成 env var)|
| feat | cds | B15 docker run 加 `--network-alias <service.id>`,让 cds-compose 短名(如 db / redis)能被同 network 内 DNS 解析 |
| feat | cds | B16 env self-reference fixed-point 死循环修复:resolveEnvTemplates 用 customEnv 作 vars(而不是 mergedEnv 自身),profile.env 引用 ${X} 直接拿 customEnv.X 完全展开值 |
| feat | cds | B17 BuildProfile.prebuiltImage 字段 + container.ts 跳过 srcMount(预构建镜像不应被仓库源码 mount 覆盖 image 自带文件);compose label `cds.prebuilt-image` 触发 |
| docs | cds | plan.cds-mysql-readiness.md § 五 加 Phase 7 ✅ 一行,完整记录 9 个 bug + Twenty CRM 端到端跑通的证据 |
