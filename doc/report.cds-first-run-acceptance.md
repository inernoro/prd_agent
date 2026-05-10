# CDS 新用户首轮功能验收 · 报告

> **版本**：v0.2 | **日期**：2026-05-11 | **状态**：执行中

## 验收口径

本轮按“无经验用户第一次遇到平台”的方式走流程。默认假设所有能力都不可用，逐项实际验证；每项只在有证据时改成“通过”，不能只看代码或只看接口猜测。

## 环境

| 项目 | 预览地址 | 目标 |
|------|----------|------|
| MAP Admin | https://main-prd-agent.miduo.org/ | 验证 CDS 控制台、项目列表、分支、构建、运维入口 |
| imp-admin | https://main-mdimp.miduo.org/ | 验证业务登录、预览转发、数据库初始化相关路径 |
| 米多工单系统 | https://main-mytapd.miduo.org/ | 验证业务登录、预览转发、内部 URL 泄漏问题 |
| CDS 修复分支 | https://codex-cds-first-run-acceptance-prd-agent.miduo.org/ | 验证 `/_cds` 源项目过滤修复 |

## 验收表

| 编号 | 场景 | 新用户动作 | 预期结果 | 状态 | 证据 / 备注 |
|------|------|------------|----------|------|-------------|
| A01 | 打开 MAP Admin 预览 | 访问 `https://main-prd-agent.miduo.org/` | 页面正常渲染，无 5xx / 空白页 | 通过 | HTTP 200；浏览器进入 MAP 落地页，可见“进入 MAP”等主内容 |
| A02 | 打开 imp-admin 预览 | 访问 `https://main-mdimp.miduo.org/` | 页面正常渲染，可进入登录或业务首页 | 通过 | HTTP 200；浏览器进入 `IMP管理后台` 登录页 |
| A03 | 打开 mytapd 预览 | 访问 `https://main-mytapd.miduo.org/` | 页面正常渲染，可进入登录或业务首页 | 通过 | HTTP 200；浏览器进入 `米多工单平台` 登录页 |
| B01 | preview hostname 的 CDS bypass 可用 | 从预览域名访问 `/_cds/api/projects` 或同类接口 | 能拿到当前 source-project 范围内的数据，不串项目 | 部分通过 | CDS 远端手动带 `x-cds-source-host: main-mdimp.miduo.org` 后只返回 mdimp，证明 master 过滤可用；普通请求仍返回全量，说明第一跳全局 forwarder 还未上线本分支的 source-host 注入修复 |
| B02 | 分支列表可发现 | 新用户进入 CDS 后找到项目分支列表 | 能看到 main 分支和状态，不出现跨项目脏数据 | 部分通过 | CDS 远端手动带 `x-cds-source-host: main-mdimp.miduo.org` 后只返回 `mdimp-main`；普通 preview 请求仍依赖 forwarder 修复合入主服务 |
| B03 | 拓扑 / 运维入口可用 | 从分支进入拓扑或运维侧栏 | 运维侧栏不遮挡页面按钮，ESC 或关闭按钮可退出 | 部分失败 | mytapd 预览页展开 CDS 面板时出现 mdimp 的 service 更新项，属于 B01 同源串项目问题；面板本身不挡登录表单 |
| B04 | 容器日志可用 | 查看某个 service 的日志 | 日志可读，密钥被 mask，不泄漏明文 | 未跑 | 待测；需在 forwarder 过滤上线后避免误查其他项目 service |
| B05 | 部署入口可用 | 从 UI 触发或查看 deploy | 状态能从排队 / 构建 / 运行中流转，有失败原因 | 通过 | CDS 修复分支已通过 `/_cds/api/branches/prd-agent-codex-cds-first-run-acceptance/deploy` 触发远端部署，SSE 日志显示拉取 commit、构建 admin/api、启动成功，预览最终 HTTP 200 |
| C01 | 数据库初始化入口可发现 | 新用户在 mdimp 类项目里找初始化 schema 的入口 | 分支列表或拓扑详情有明显入口，能跳到项目设置 env tab | 通过 | `cds.miduo.org/branches/defd4695ab5f` 顶部可见“数据库初始化(schema.sql)”banner 和“上传初始化 SQL”按钮 |
| C02 | 数据库初始化条件正确 | 对纯前端项目和 SQL infra 项目分别看 banner | 纯前端不误展示；mysql/postgres/mariadb 项目展示 | 初步通过 | mdimp 显示；MAP 纯前端未在本轮系统化复核，需后续补一条反向验证 |
| C03 | SQL 上传 / 配置可用 | 打开 EnvSetupDialog，检查 schema.sql 上传卡片 | 能识别 `CDS_MYSQL_*`、`CDS_POSTGRES_*`、`DATABASE_URL` 等信号 | 通过 | 点击 banner 后进入 `settings/defd4695ab5f#env`，打开向导后等待 infra 检测完成，可见“上传 init.sql”卡片 |
| C04 | 数据持久化可用 | 重启 / 重部署后检查业务数据 | mysql 数据不丢，volume 没串项目或串分支 | 未跑 | 待测 |
| D01 | imp-admin 登录闭环 | 打开 imp-admin，按已知登录路径进入业务 | 登录返回业务成功码，JWT / session 生效 | 未跑 | 待测 |
| D02 | mytapd 登录闭环 | 打开 mytapd，按已知登录路径进入业务 | 登录接口 200，JWT 生效 | 失败 | 浏览器保存凭据自动填入后点击登录，按钮进入加载态但页面长期停在登录页，未进入 dashboard；直连 `POST /api/auth/dev/login` 返回业务层 `账号或密码错误`，当前更像账号 / 密码配置不匹配，不是表缺失导致的 5xx |
| D03 | mytapd 内部 URL 泄漏复测 | 打开前端 bundle 或 network 请求 | 不应出现生产包硬编码 `:8080` 内部地址 | 初步通过 | 已克隆 `MiDouTech/myTapd` 到父目录；当前 `miduo-frontend/.env.production` 为 `VITE_API_BASE_URL=/api`，未见生产 env 硬编码 `:8080`；预览当前为 Vite dev 模式，需结合 network 再查登录卡住原因 |
| E01 | 新项目 onboard 可用 | 用仓库从零导入项目 | scan 识别服务、端口、env、init SQL；不生成 ghost service | 部分通过 | myTapd 已在父目录克隆并生成 `cds-compose.yml`、`application-cds.yml`、`bootstrap-cds.yml`；`cdscli scan/verify` 通过。本地分支无法推送到 `MiDouTech/myTapd`，CDS 远端部署被 GitHub 权限卡住 |
| E02 | service 数量可控 | 对 mdimp 类多模块项目查看 service 列表 | 不需要的子前端有清晰处理方式，不误挂红 | 未跑 | 待测 |
| E03 | 初次失败可理解 | 故意走一个失败路径 | UI 给出人能看懂的原因和下一步，不只显示红条 | 未跑 | 待测 |

## 第一轮执行顺序

1. 先验证 A01-A03：确认三个预览页面不是空白或 5xx。
2. 再验证 B01-B04：从 preview hostname 走 `/_cds/api/...`，避免直连 CDS 导致 source-project 过滤失真。
3. 再验证 C01-C03：重点看数据库初始化入口是否真的对新用户可见。
4. 然后下载业务仓库做 E01：只在需要时把 mytapd 和 mdimp 克隆到本项目父目录。
5. 最后根据失败项决定修 prd_agent/CDS，还是转交业务仓库。

## myTapd 数据库初始化结论

myTapd 的权威数据库初始化机制是 Spring Boot 启动时执行 Flyway migration，不是手工上传一个通用 `schema.sql`。迁移脚本位于业务仓库 `ticket-platform/ticket-bootstrap/src/main/resources/db/migration/`，其中 `V1__init_base.sql` 创建 `department`、`sys_user`、`sys_role`、`sys_user_role` 等基础表，`V51__add_external_user_login.sql` / `V52__repair_external_user_password_hash.sql` 增加外部手机号密码登录所需的 `password_hash` 并写入外部账号。

当前仓库配置存在一个关键矛盾：`application.yml` 和 `application-dev.yml` 均配置 `spring.flyway.enabled: true`，但 `application-prod.yml` 配置 `spring.flyway.enabled: false`；同时 Dockerfile / 生产 compose 默认 `SPRING_PROFILES_ACTIVE=prod`。如果 CDS 以 prod profile 启动 myTapd 后端，空库不会自动执行 Flyway，首次登录自然缺少业务表 / 用户数据。

CDS 当前 UI 的“上传 init.sql”入口只能把 SQL 文件放到仓库并要求 `cds-compose.yml` 显式挂载到 `/docker-entrypoint-initdb.d/`。这个路径只会在 MySQL 空 volume 首次启动时执行，已有 volume 不会重复执行；而且 myTapd 仓库目前没有根级 `cds-compose.yml`，本地 docker compose 的 MySQL 也没有挂载 init SQL。因此对 myTapd 来说，单纯上传 SQL 并不等于完成初始化。

建议的初始化路径：

1. 对 CDS 灰度 / 测试环境，把后端 profile 改成 dev 或专用 cds profile，并确保 `spring.flyway.enabled=true`、datasource 指向当前分支独立 MySQL。
2. 确保 MySQL 中存在目标库 `ticket_platform`，或由 MySQL `MYSQL_DATABASE=ticket_platform` 首次创建。
3. 重启 / 重部署后端服务，让 Flyway 执行 `V1...V52...` 迁移脚本。
4. 如果 MySQL volume 已存在但库是半初始化状态，需要先重置该分支 MySQL volume，或在容器里手动执行 Flyway repair / migrate；把 SQL 放进 `/docker-entrypoint-initdb.d/` 对已有 volume 不会生效。
5. 初始化后验收 `flyway_schema_history` 有成功记录，`sys_role` 至少有 ADMIN / OBSERVER 等基础角色，`sys_user` 有 dev 或外部登录账号，再验证 `/api/auth/dev/login` 或 `/api/auth/local/login`。

## 本轮 CDS 远端验证记录

| 项目 | 验证项 | 结果 | 证据 |
|------|--------|------|------|
| prd_agent | 修复分支部署到 CDS | 通过 | 分支 `codex-cds-first-run-acceptance` 已推送；远端部署拉取 commit `fa284333`，构建 admin/api 完成，预览地址 HTTP 200 |
| prd_agent | `/_cds/api/projects` 源项目过滤 | 部分通过 | 手动带 `x-cds-source-host: main-mdimp.miduo.org` 时只返回 mdimp；不带时仍返回全量，等待 forwarder 注入头修复进入主服务 |
| prd_agent | `/_cds/api/branches` 源项目过滤 | 部分通过 | 手动带源 host 时只返回 `mdimp-main`；不带时仍返回全量 |
| prd_agent | `/_cds/api/build-profiles` 源项目过滤 | 部分通过 | 手动带源 host 时只返回 mdimp 的 `imp-api-mdimp` 和 `imp-admin-mdimp` |
| myTapd | CDS compose 扫描 / 校验 | 通过 | `cdscli scan` 识别根级 `cds-compose.yml`；`cdscli verify` 通过，仅有前端 schema 警告 |
| myTapd | CDS 远端部署 | 阻塞 | 本地 commit 已生成，但 GitHub push 返回 403；GitHub connector 创建分支也返回 `FORBIDDEN Resource not accessible by integration` |

## 待办优先级

| 优先级 | 事项 | 下一步 |
|--------|------|--------|
| P0 | `/_cds` 普通请求仍返回全量项目 | 将 forwarder 的 `x-cds-source-host` 注入修复合入并部署到 CDS 主服务；上线后复测普通 preview 请求，不再手动带 header |
| P0 | myTapd 新环境空库无法登录 | 需要把 myTapd 的 `application-cds.yml`、`bootstrap-cds.yml`、`cds-compose.yml` 推到业务仓库或通过 pending import 审批流导入 CDS；当前缺少业务仓库写权限 |
| P1 | myTapd 当前 main 登录账号失败 | 区分“当前库账号配置不匹配”和“新环境空库未迁移”；先查 `flyway_schema_history`、`sys_user`、`external_user` 后再决定修账号还是修初始化 |
| P1 | B04 日志 / C04 持久化 / E02 子前端 | 等 P0 源项目过滤上线后，从真实预览 UI 继续验收 |
