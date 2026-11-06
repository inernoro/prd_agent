# DeepAudit 的 CDS 部署包

**一句话**：把固定提交的 DeepAudit 作为禁用动态执行的独立审查引擎接入 CDS。
**谁该读**：维护 CDS 审查引擎、镜像和服务凭据的工程师。
**读完能做什么**：准备 Fork、生成同提交镜像，并按真实入口完成部署验收。

上游来源和固定提交在 `upstream.json`。本目录保留安装覆盖层，不复制第三方完整源码。上游根目录的 AGPL 许可证保留不变，修改后的对应源码应随 Fork 提供。

1. 在 GitHub 创建 `inernoro/DeepAudit` Fork，检出记录的完整上游提交并建立功能分支。GitHub 连接必须具有创建 Fork 和推送工作流的权限；创建失败时不要换成不存在的仓库或未经校验的上游镜像。
2. 在 MAP 仓库运行 `python3 scripts/deepaudit-prepare.py --checkout <DeepAudit Git 根目录>`。安装器拒绝非固定提交、错误远端和覆盖已有改动。之后在 Fork 运行 `sh cds-release.sh check`。
3. 提交 Fork 覆盖层并推送。`ci.yml` 校验项目发布脚本；CDS 识别的 `branch-image.yml` 同样校验脚本、构建两个镜像、验证禁用接口，并发布 `sha-<完整提交>` 镜像。预构建模式不使用 latest 或未经证明的回退镜像。
4. 使用 CDS 项目接入技能创建独立 DeepAudit 项目。先以 `POST /api/infra` 和 `initializeStorage: new-only` 为该项目分别分配 PostgreSQL 与 Redis 的全新归属卷，再导入 Fork 根目录 `cds-compose.yml`。只使用该项目环境变量；数据库、Redis、JWT 和服务账号密码由项目内独立生成。配置网关地址、模型、专属网关凭据与管理员 htpasswd bcrypt 哈希。管理前端通过 CDS 的同分支 `backend` 服务别名访问后端。
5. 使用 CDS 返回的实际服务地址配置调用方。CDS 审查适配器使用服务邮箱和服务密码登录后台 API；管理端另外经过 HTTP Basic 认证。后端没有公开路径前缀或 Web 入口。首次迁移由后端启动脚本执行；显式项目发布路径还包含独立 db-migrate 作业。
6. 项目脚本发布使用 `cds-release.sh check/deploy` 与 `docker-compose.cds-release.yml`。正式脚本要求完整部署提交和实际管理 URL；部署前验证 Compose 配置，管理端只绑定本机端口，反向代理应由部署目标明确管理。
7. 验收必须覆盖 ZIP 审查、服务账号登录、报告读取、重启后状态恢复、未登录管理入口拒绝，以及登录后 HTML 与实际入口 JS/CSS。仅容器健康或匿名 401 不表示业务已完成。

运行时不会创建演示账号，已有演示账号会被停用；不会挂载 Docker socket，也不会注册动态 Agent、SSH 或任意数据库管理端点。普通扫描使用上游后台任务，后端重启会将中断任务明确标为失败，由 CDS 展示并提供重试。

本地验收记录（2026-11-06）：在固定上游提交及本覆盖层上，两个镜像实际构建成功；运行时路由、静态策略和安装边界共 10 项测试通过。独立 Compose 实例执行完整 PostgreSQL 迁移、启动 Redis 和两个业务服务；管理页匿名访问 401，认证 HTML 与 6 个入口 JS/CSS 返回 200，服务账号登录及身份查询成功，演示账号登录被拒绝。重启后，预置 pending/running 任务均变为带完成时间的 failed，上传卷内容保留。

这些证据覆盖本地隔离部署；正式 CDS 地址、模型调用、私有仓库与完整 CDS 提交审查流程由集成验收继续验证。

CDS 配置导入后、部署前，读取 `cds-storage-plan.json`，对后端 profile 调用 `POST /api/branches/:id/storage/provision`，请求包含 `profileId`、`initializeStorage: new-only` 和该文件 `backend` 数组作为 `freshMounts`。两个目标为 `/app/uploads` 与 `/app/data`，均为 `persistent`。CDS 分配的实际卷名与实例、项目、分支和服务绑定；预检发现已有挂载或已有出生记录时停止，禁止接管旧卷或改名重试。预构建镜像本身没有 Docker VOLUME 隐式持久卷。

CDS 的新归属卷使用 nocopy，初始根目录由 root 持有。镜像启动入口只初始化固定的上传、数据与缓存目录权限，然后通过 gosu 切换为 UID/GID 10001 执行迁移和分析服务。CI 使用两个真实 root-owned nocopy 卷验证写入与降权；不通过宿主临时 chmod、不挂 Docker socket、不以 root 分析上传源码。

网关专用服务密钥使用 `sourceSystem: external`、`clientCode: deepaudit`、`purpose: external-platform`，仅绑定一个新用途（如 `deepaudit.code-review::chat`），协议为 `openai-compatible`，权限为 `invoke`、`stream:invoke`、`route:read`。兼容入口可从单用途密钥推断 appCaller，DeepAudit 使用标准 Bearer 即可；无需额外来源头。`LLM_MODEL` 使用 `openai/<逻辑模型 publicId>`，例如 `openai/deepseek/deepseek-v4.1-flash-1017`；此前缀由 LiteLLM 消费，网关收到完整 publicId。`LLM_BASE_URL` 填平台实际返回的网关 OpenAI 入口（以 `/v1` 结尾）。SSO 使用正常账号登录与平台签发的单次票据；配置审批由用户完成。

线上验收记录（2026-11-06）：独立项目 `f9cd30ef1696` 的 `feat/cds-integration` 已运行 Fork 提交 `b300c10092289c27da98519a2094004c35d529d2`，对应 [Branch Image CI](https://github.com/inernoro/DeepAudit/actions/runs/42203069192) 成功。管理员入口由 CDS 实际返回为 [DeepAudit 管理页](https://cds-integration-feat-deepaudit.miduo.org)，匿名 401、正常认证 HTML 与 6 个入口资源读取通过。API 服务账号登录、模型目录与真实对话探针成功；已知问题 ZIP 样本完成 1/1 个支持文件分析，29.8 秒得到 10 项发现，涵盖五个维度，源码未执行。该记录证明部署和分析路径，当前项目结论以 CDS 归档报告的覆盖说明为准。

通过 CDS 官方原地重启接口验收后，已完成任务全文、10 条发现的校验和、ZIP 元数据及 ZIP 内文件清单、服务账号模型与 1ms 请求间隔配置均保持一致；容器与端口保持原值。实际后端进程 `/proc/1/status` 的 UID/GID 均为 10001。重新部署后的内部端口可能变化，调用方应从 CDS 运行时资源读取实际地址。

管理员登录验收（2026-11-06）：Fork `64f1cfaa0fe5ca97ee3f98ac65a19800b2f4c51b` 通过 [Branch Image CI](https://github.com/inernoro/DeepAudit/actions/runs/42228895599)，CDS 已正式运行此版本。网页登录支持固定别名 `admin`，映射到独立真人账户 `cds-admin@example.com`；密码仍由原认证接口校验并签发 JWT。该账户与 `CDS_SERVICE_EMAIL/PASSWORD` 的机器账户相互独立。管理员外层 Basic、应用账户及项目密钥管理保管字段使用部署方指定密码，文档和仓库不记录密码。后端七项真实认证/路由测试、三项策略测试、覆盖层五项安装边界测试、前端类型检查及镜像构建通过。

静态界面最终验收（2026-11-06）：Fork `50de6003765cd7da3932d7ceaa23f7d98a37573c` 通过 [Branch Image CI](https://github.com/inernoro/DeepAudit/actions/runs/42230759130)，CDS 已正式运行此版本。仅 `Dockerfile.cds` 开启 `VITE_CDS_STATIC_REVIEW=true`：主页跳转项目列表，Agent 导航、快捷操作与任务卡片隐藏，Agent 深链跳转项目列表，仪表盘和普通审计任务页不请求动态接口；普通上游构建在 flag 为 false 或缺省时保留原行为。七项双模式页面/路由测试、前端类型检查与构建通过，并作为 CDS 镜像构建必经步骤。被覆盖的上游页面均以固定提交和逐文件 SHA-256 保护，安装器拒绝覆盖操作员已有修改。

真实 Chromium 在正式 URL 使用 `admin` 正常表单登录后进入项目列表，显示 `https://github.com/inernoro/prd_agent.git`，并逐页访问仪表盘和普通审计页；脚本异常、控制台错误、失败 HTTP 请求和 Agent 请求均为零。390px 手机布局无横向溢出。此次仅建立视觉验收项目，未触发审查执行。静态管理页匿名返回 401，匿名项目 API 返回 401，Agent 与注册 API 返回 404，机器账号正常登录且身份与真人账户不同。业务审查执行和结论以 CDS 任务与归档报告为准。
