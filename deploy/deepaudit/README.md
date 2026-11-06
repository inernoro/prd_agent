# DeepAudit 的 CDS 部署包

**一句话**：把固定提交的 DeepAudit 作为禁用动态执行的独立审查引擎接入 CDS。
**谁该读**：维护 CDS 审查引擎、镜像和服务凭据的工程师。
**读完能做什么**：准备 Fork、生成同提交镜像，并按真实入口完成部署验收。

上游来源和固定提交在 `upstream.json`。本目录保留安装覆盖层，不复制第三方完整源码。上游根目录的 AGPL 许可证保留不变，修改后的对应源码应随 Fork 提供。

1. 在 GitHub 创建 `inernoro/DeepAudit` Fork，检出记录的完整上游提交并建立功能分支。GitHub 连接必须具有创建 Fork 和推送工作流的权限；创建失败时不要换成不存在的仓库或未经校验的上游镜像。
2. 在 MAP 仓库运行 `python3 scripts/deepaudit-prepare.py --checkout <DeepAudit Git 根目录>`。安装器拒绝非固定提交、错误远端和覆盖已有改动。之后在 Fork 运行 `sh cds-release.sh check`。
3. 提交 Fork 覆盖层并推送。新增的 `ci.yml` 校验项目发布脚本、构建两个镜像、验证禁用接口，并发布 `sha-<完整提交>` 镜像。预构建模式不使用 latest 或未经证明的回退镜像。
4. 使用 CDS 项目接入技能创建独立 DeepAudit 项目并导入 Fork 根目录 `cds-compose.yml`。只使用该项目环境变量；数据库、Redis、JWT 和服务账号密码由项目内独立生成。配置网关地址、模型、专属网关凭据、管理员 htpasswd bcrypt 哈希与当前分支后端内部 URL。使用 CDS 管理的持久存储绑定，并核对上传目录、数据库和 Redis 的持久化归属。
5. 使用 CDS 返回的实际服务地址配置调用方。CDS 审查适配器使用服务邮箱和服务密码登录后台 API；管理端另外经过 HTTP Basic 认证。后端没有公开路径前缀或 Web 入口。首次迁移由后端启动脚本执行；显式项目发布路径还包含独立 db-migrate 作业。
6. 项目脚本发布使用 `cds-release.sh check/deploy` 与 `docker-compose.cds-release.yml`。正式脚本要求完整部署提交和实际管理 URL；部署前验证 Compose 配置，管理端只绑定本机端口，反向代理应由部署目标明确管理。
7. 验收必须覆盖 ZIP 审查、服务账号登录、报告读取、重启后状态恢复、未登录管理入口拒绝，以及登录后 HTML 与实际入口 JS/CSS。仅容器健康或匿名 401 不表示业务已完成。

运行时不会创建演示账号，已有演示账号会被停用；不会挂载 Docker socket，也不会注册动态 Agent、SSH 或任意数据库管理端点。普通扫描使用上游后台任务，后端重启会将中断任务明确标为失败，由 CDS 展示并提供重试。
