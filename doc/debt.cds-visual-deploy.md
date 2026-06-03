# CDS 绝对可视化一键部署 · 工程债务与待补台账

> **类型**：debt（工程债务台账） · **日期**：2026-06-02 · **状态**：核心已落地，本台账记录已知边界与 backlog
> **关联**：`design.cds-visual-deploy.md`、`report.cds-visual-deploy.md`、`plan.cds-visual-deploy.md`、`guide.cds-one-click-deploy.md`
> **一句话**：onboarding→部署核心已商业级可用（经验收通过）；以下是诚实记录的已知边界与低边际 backlog，按价值排序，供后续按需取用——不在表里的都已落地。

---

## 一、已知边界（设计取舍，当前不做）

| # | 边界 | 现状 / 取舍原因 | 影响 |
|---|---|---|---|
| B1 | 同类型多实例**仅对数据库**（supportsDbName）开放 | 只有数据库的连接串 host 能被安全改写到实例别名；缓存/队列多实例需各自的连接串改写规则 | 想挂两个 Redis 暂不支持，单个够用 |
| B2 | initSql **不随容器就绪自动执行** | 现为"随项目保存 + 拓扑数据面板一键载入执行"；自动执行需 DB 就绪轮询 + 幂等标记 + 错误处理 | 用户需手动点一次 |
| B3 | 检测覆盖有限 | `DetectedStack` 只有 `nodejs/python/go/rust/java/ruby/php/dockerfile/unknown` 九值；**.NET / 静态站点没有独立 stack id**——.NET 带 Dockerfile 落 `dockerfile`（manualSetupRequired），静态站点落 `nodejs` + framework(Vite 等)走 suggestedBuildCommand。故 `detect-runtime` 的 `stackToRuntime` 对这九值已穷尽，**不要给它加 `dotnet`/`static` 键**（detectStack 永不产出，纯死代码——2026-06-03 Cursor 误报过一次）。冷门栈/魔改构建落"未识别" | 少数项目要手填 + 靠试运行兜底 |
| B4 | 试运行只验**单服务**「镜像+命令+端口能否常驻 + 端口响应」 | 多服务联调依赖、基建连接串注入（DATABASE_URL 等）在正式部署才有，不在一次性容器里 | 试运行测"这条命令能起住"，非"全栈联调" |
| B5 | 端口探活极简镜像降级 | 首选 `/proc/net/tcp`（任何容器都有）；无 `/proc` 的极特殊镜像降级为"容器常驻=需确认"而非误判失败 | 极少数镜像探活降级 |
| B6 | AI 生成 compose **仅设计未实现** | 见 `design.cds-ai-compose.md`；按用户"备选"定位，借用 CDS Agent/OpenRouter，未写代码 | 当前靠确定性检测器，AI 路径待建 |
| B7 | CDS 自身跑在本特性分支 | 经 `self-force-sync` 上线；合并 main 后应 `self update --branch main` 切回 | 运维提醒 |
| B9 | detect-runtime / validate-runtime **仅管理员/控制台会话可用**(项目级 agent key 403) | 这两个"项目创建前"接口用服务器级 GitHub Device Flow 凭据克隆任意仓库 + 跑任意命令 + 回流日志,绑不到具体项目;放行项目级 key 等于借服务器凭据 exfil 任意私有仓库(PR #711 P1 修复)。同理数据/备份端点省略 ?project= 且 id 跨项目歧义时 400 要求指定项目 | 用项目级 key 的自动化流程跑不了 pre-create 检测/试运行,需用管理员凭据;若未来要支持,得先把 clone 绑定到该 key 授权的仓库白名单 |
| B8 | 后台任务(worker)就绪探测走 **noHttp（TCP 探活）**，不支持"完全不监听端口"的纯 worker | worker 角色的 BuildProfile 现设 `readinessProbe.noHttp=true`：跳过 HTTP "/" 探测，只 TCP 探活端口（PR #711 review 修复"活着的 worker 被 HTTP 探测超时误判失败"）。但 deploy 的 noHttp 仍要求 TCP accept——绑健康/TCP 端口的 worker 即就绪；**完全不 listen 任何端口的纯 worker 仍会超时**，需 `startupSignal`(日志正则)模式，而创建弹窗暂未收集该输入 | 纯无端口 worker 暂不可一键部署，需手填 startupSignal（后续可在弹窗加"就绪日志关键字"输入） |

## 二、Backlog（低边际打磨，按价值排序）

> 勘探确认部署机制本身扎实（SSE 事件流、容器日志、`docker restart` 恢复、TCP+HTTP 就绪探测、依赖拓扑、预览域名生成均已实现）。以下为锦上添花，每项边际价值已不高。

1. **实时部署阶段流到前端**：后端已发阶段事件，前端目前靠日志事后推断（部署中只见转圈）。改为显式 SSE 阶段事件 + 前端 live 阶段树。可单测（mock SSE → 组件渲染阶段）。
2. **就绪探测进度计数**：`waitForReadiness` 内部有 attempt/max，UI 未透出（用户在 3-5 分钟启动时看不到"第 15/90 次")。
3. **HTTPS/DNS 就绪校验**：当前假定 Nginx + 证书就绪，不主动探 `https://<preview>`；失败时是静默 404/TLS 错。
4. **一键回滚 / 从错误态一键重部署**：现需回分支列表重新触发；无版本快照/回滚。
5. **onboarding 三个 P3**（最终验收子智能体提）：
   - 试运行按钮在未填仓库时给 disabled 提示，而非点击后才报；
   - 用户手改镜像（非改运行时下拉）时，启动命令不自动联动 → 易产生第一次"不通过"；
   - 检测把 2 个默认服务合并为 1 个（单入口应用）是对的，但回填文案可更明确说明"服务数变了"。
6. **CLI `_INFRA_TEMPLATES` 收敛到 `infra-catalog.ts`**：消除三处漂移的最后一处（前端 + 后端已收敛，CLI 待收）。
7. **拓扑「新增基础设施」弹窗接多实例/库名/initSql 输入**：后端 `infra-presets` 已支持 infraConfigs/infraExtra，创建弹窗已全接，拓扑弹窗 UI 待接。

## 三、观察到的既有问题（非本轮引入，建议单独过一遍）

- **分支详情抽屉底部容器日志块在白天主题下偏暗**：疑似 `--bg-terminal`（light = `#1f1d2b` 暗色）与 `cds/CLAUDE.md` §0「白天禁暗色背景」的历史矛盾。值得按 `.claude/rules/cds-theme-tokens.md` 单独过一遍（终端/日志块在白天应浅底深字）。

## 四、独立 fixture demo 阻塞（承接 plan §六）

用真实示例 fixture 在 cds.miduo.org 建一个全新独立 demo 项目跑通，受"onboard 仅在仓库根探测 compose + 示例在子目录 + 沙盒 GitHub 写权限限定本仓库"约束未完成。两条解法（用户新建空 repo 放 fixture，或接受 prd_agent 孤儿分支）见 `plan.cds-visual-deploy.md` §六。**注**：CDS 平台当前在跑 6 个隔离项目（含本分支前后端 running），"可视化平台部署并运行 N 个前后端"能力本身已证实可用——此项是"演示一个全新真实项目"的取证，非能力缺失。
