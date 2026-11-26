# /cds 一句话路由（按 CDS 菜单）

> 程序生成，不要手改。改说法在 `menu-intents.json`，页面、技能、命令和风险来自 CDS 的 Agent 任务注册表（`agent-mission-registry.ts`）。

用户说 `/cds <一句话>`：先按下表找到菜单和任务，读「先读」里的技能和文档，按「步骤」做；写操作按「风险」确认。一句话对不上任何一行时，列出菜单名问一次。

## 项目列表

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 建项目`、`/cds 接入一个仓库` | 项目扫描与接入 | `cds-deploy-pipeline/SKILL.md`、`preview-url/SKILL.md`、`cds-project-scan/SKILL.md` | `cdscli import`、`cdscli scan`、`cdscli verify`、`cdscli project`、`cdscli env`、`cdscli key` | 会写入 |
| `/cds 有哪些项目`、`/cds 看项目状态` | 项目与 Agent 接入 | `cds-deploy-pipeline/SKILL.md`、`preview-url/SKILL.md` | `cdscli project`、`cdscli env`、`cdscli key` | 会写入 |
| `/cds 部署这个分支`、`/cds 看预览地址` | 分支部署与预览 | `preview-url/SKILL.md`、`cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli deployment-run`、`cdscli deployment-version` | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 改项目配置`、`/cds 改路由` | 项目设置 | `cds-project-scan/SKILL.md` | `cdscli scan`、`cdscli verify`、`cdscli project`、`cdscli env`、`cdscli key` | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 接数据库`、`/cds 接缓存` | 项目服务与依赖接入 | `cds-deploy-pipeline/SKILL.md`、`cds-project-scan/SKILL.md` | `cdscli branch`、`cdscli db` | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 设置环境变量`、`/cds 环境变量没生效` | 项目环境变量排查 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli project`、`cdscli env`、`cdscli key` | 会写入 |
| `/cds 构建失败了` | 构建失败排查 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli deployment-run` | 会写入 |
| `/cds 服务起不来` | 服务无法启动排查 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli deployment-run` | 会写入 |
| `/cds 查日志` | 项目日志与异常排查 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli health`、`cdscli auth`、`cdscli self` | 会写入 |
| `/cds 这个接口有问题` | 项目重要接口排查 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli db`、`cdscli health`、`cdscli auth`、`cdscli self` | 会写入 |
| `/cds 预览打不开` | 预览入口异常排查 | `preview-url/SKILL.md`、`cds-deploy-pipeline/SKILL.md` | `cdscli branch` | 会写入 |
| `/cds 看当前页面`、`/cds 先帮我看看` | 当前 CDS 页面 | `cds-deploy-pipeline/SKILL.md` | `cdscli branch`、`cdscli project`、`cdscli env`、`cdscli key`、`cdscli health`、`cdscli auth`、`cdscli self` | 会写入 |

### 项目扫描与接入

扫描当前代码库、识别技术栈和服务依赖，生成可审阅的 CDS 接入方案。 页面：`/settings/<项目>`。

步骤：
1. 检查当前仓库、远端和已有 CDS 项目绑定
2. 运行 cdscli scan 与 verify 生成并校验部署结构
3. 列出缺失的项目环境变量和外部依赖
4. 提交接入方案并在批准后部署验证

完成标准：项目绑定正确；部署结构验证通过；缺失依赖和变量均有明确状态。

### 项目与 Agent 接入

识别仓库、连接已有项目或创建新项目，并把部署推进到可预览状态。 页面：`/project-list`。

步骤：
1. 列出 CDS 项目并用仓库远端、项目 ID 和 slug 识别真实目标
2. 优先连接已有项目，只有确认不存在时才创建
3. 检查项目默认分支、仓库绑定和构建配置
4. 部署后调用 preview-url 获取真实入口

完成标准：项目身份唯一确定；项目与仓库绑定正确；真实预览入口可访问。

### 分支部署与预览

理解当前项目与分支，完成部署、等待就绪和真实预览验证。 页面：`/branches/<项目>`。

步骤：
1. 确认当前项目、Git 分支和目标提交
2. 读取分支状态与最近部署运行
3. 用 profile list 找到 prebuiltModes 里的极速版模式，再用 branch set-mode 只写当前分支覆盖
4. 触发部署并持续等待阶段变化（等 CI 镜像就绪也是阶段，不是失败）
5. 就绪后执行 smoke 和 preview-url，失败就修代码重新 push，循环到通过

完成标准：目标提交已部署；branch status 的 deployRuntime.prebuiltCoverage 为 all 且未待生效；服务健康；真实预览入口可访问。

### 项目设置

读取目标项目的现有配置，自动补齐运行方式、依赖和部署声明。 页面：`/settings/<项目>`。

步骤：
1. 读取目标项目当前设置和配置来源
2. 对照仓库结构识别缺失或漂移
3. 解释影响后保存最小变更
4. 重新读取并用部署验证

完成标准：项目设置保存成功；配置来源明确；目标分支按新配置运行。

### 项目服务与依赖接入

识别数据库、缓存、消息和外部服务依赖，优先复用 CDS 已有能力。 页面：`/settings/<项目>`。

步骤：
1. 扫描代码和部署结构中的依赖声明
2. 查询 CDS 当前项目可用资源与连接信息
3. 选择复用、创建或外部接入方案
4. 部署后验证应用到依赖的真实连接

完成标准：依赖资源状态健康；应用连接成功；作用域和生命周期符合预期。

### 项目环境变量排查

检查项目环境变量的缺失、占位符、作用域和运行时注入，不让密钥进入仓库。 页面：`/settings/<项目>`。

步骤：
1. 从代码和部署结构提取所需变量名
2. 读取 CDS 项目环境变量的脱敏键列表
3. 识别缺失、占位符和作用域错误
4. 补齐后重新部署并验证运行时状态

完成标准：必需变量均存在；作用域正确；应用启动和核心接口验证通过。

### 构建失败排查

读取真实构建日志和提交差异，定位依赖安装、编译、镜像或产物阶段错误。 页面：`/branches/<项目>`。

步骤：
1. 读取目标分支状态、部署运行和完整构建日志
2. 定位第一个导致退出的错误而不是最后一行噪音
3. 结合目标提交检查依赖、锁文件、构建脚本和镜像阶段
4. 修复后创建新的部署运行并比较结果

完成标准：首个有效错误已解释；新构建通过；修复未引入无关依赖漂移。

### 服务无法启动排查

检查容器退出原因、启动日志、健康探针和依赖服务，不用反复重启掩盖问题。 页面：`/branches/<项目>`。

步骤：
1. 运行 cdscli diagnose 或 help-me-check 获取分支事实
2. 读取容器退出码、停止原因和启动日志
3. 核对入口命令、监听地址、端口、健康探针和依赖状态
4. 修复后重新部署并观察稳定窗口

完成标准：容器持续运行；健康探针通过；停止原因和修复形成闭环。

### 项目日志与异常排查

围绕项目、分支和时间窗口关联构建日志、容器日志、HTTP 日志与服务事件。 页面：`/branches/<项目>`。

步骤：
1. 确定项目、分支、服务和时间窗口
2. 分别读取构建、运行、HTTP 与事件记录
3. 按 trace、状态码和时间关联证据
4. 使用最小只读请求验证假设

完成标准：异常时间线完整；根因或排除项有证据；验证步骤可以重复。

### 项目重要接口排查

检查关键接口的鉴权、路由、依赖、响应结构和耗时，避免只看页面报错。 页面：`/branches/<项目>`。

步骤：
1. 确认接口方法、路径、预期身份和目标分支
2. 读取同一请求的 HTTP 日志、服务日志和 trace
3. 使用只读或可回滚样本复现状态码与响应
4. 检查路由、鉴权、参数、依赖和超时配置

完成标准：接口问题可复现或已排除；错误层级明确；修复后状态码、响应和耗时符合预期。

### 预览入口异常排查

检查服务已运行但预览打不开、路由错误、静态资源失败或入口不完整的问题。 页面：`/branches/<项目>`。

步骤：
1. 运行 preview-url 获取全部真实入口
2. 检查目标服务和容器端口
3. 验证入口根路径、健康路径和关键静态资源
4. 关联代理日志与应用日志定位失败层

完成标准：真实入口可访问；关键资源加载成功；多入口数量与 CDS API 一致。

### 当前 CDS 页面

把当前页面、目标和安全边界一起交给 Agent，让它先理解上下文再操作。 页面：`/`。

步骤：
1. 识别当前页面、项目和分支
2. 读取页面对应的只读状态
3. 说明计划与权限边界
4. 执行后返回可验证结果

完成标准：目标上下文明确；操作结果已验证；未越过项目和权限边界。

## 发布中心

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 发布到 xx 环境`、`/cds 上线` | 正式发布 | `cds-release/SKILL.md` | — | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 回滚到上一个版本` | 部署版本回滚 | `preview-url/SKILL.md`、`cds-deploy-pipeline/SKILL.md`、`cds-release/SKILL.md` | `cdscli deployment-version` | 含删除、覆盖或回滚，执行前要明确授权 |

### 正式发布

检查发布目标、版本与回滚条件，按可追溯流程完成发布。 页面：`/release-center?project=<项目>`。

步骤：
1. 确认目标环境、提交和不可变构建产物
2. 检查域名、证书、变量和回滚点
3. 获得明确授权后执行发布
4. 从公网入口验证页面和核心接口

完成标准：最终公开入口可访问；版本与目标提交一致；回滚路径可用。

### 部署版本回滚

比较当前故障版本与可复用历史版本，在明确授权后执行可追溯回滚。 页面：`/branches/<项目>`。

步骤：
1. 读取当前部署版本和最近可用历史版本
2. 比较提交、配置和运行模式差异
3. 获得明确授权后执行 rollback
4. 验证健康状态、接口和预览入口

完成标准：目标历史版本运行；服务和入口恢复；故障版本与后续修复已记录。

## 任务调度

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 添加一个任务调度`、`/cds 每天 9 点跑 xx` | 任务调度 | 本技能 | `cdscli schedule` | 会写入 |

### 任务调度

创建或诊断定时任务，并根据运行记录验证真实执行结果。 页面：`/task-schedule?project=<项目>`。

步骤：
1. 检查时区、调度表达式和目标项目
2. 测试动作安全性和重复执行风险
3. 保存后手动触发一轮
4. 读取运行记录和真实输出

完成标准：任务按预期触发；运行记录成功；输出结果可验证。

## 验收中心

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 跑 DSN-xxx 的验收`、`/cds 领一个验收任务`、`/cds 出验收报告` | 验收报告 | `reference/test-loop.md` | `cdscli report`、`cdscli report-folder`、`cdscli acceptance` | 会写入 |

### 验收报告

领取结构化功能清单，逐项执行并留下可追溯的结果。 页面：`/reports?project=<项目>`。

步骤：
1. 读取项目测试清单与本轮环境，正式环境按当前线上执行
2. 领取任务并持续续租，按冻结步骤走真实业务路径
3. 逐项回填断言、实际结果、线上证据与清理回读
4. 结束任务后归档并绑定报告，再真实打开深链验真

完成标准：逐项结果与冻结清单一致；矩阵保留失败与不稳定历史；报告线上打开验真通过，不能用绑定成功代替。

## 监控中心

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 加一个 xx 的监控` | 加一条功能监控（用户说「帮我增加 XX 的监控」时） | `SKILL.md`「加一条功能监控（用户说「帮我增加 XX 的监控」时）」 | — | 见文档 |
| `/cds CDS 健康吗` | CDS 系统健康检查 | 本技能 | `cdscli health`、`cdscli auth`、`cdscli self` | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 看慢请求和错误` | CDS 系统接口与事件排查 | 本技能 | `cdscli health`、`cdscli auth`、`cdscli self` | 含删除、覆盖或回滚，执行前要明确授权 |

### CDS 系统健康检查

让 Agent 读取 CDS 版本、运行服务和基础设施状态，先判断故障范围再处理。 页面：`/cds-settings#maintenance`。

步骤：
1. 运行 cdscli health、version 与 self status
2. 读取最近服务事件和异常停止记录
3. 核对共享 MongoDB、Redis 与路由状态
4. 按控制面、项目面和基础设施三层给出结论

完成标准：故障层级已确定；关键服务状态有证据；下一步动作与影响范围明确。

### CDS 系统接口与事件排查

检查重要接口、慢请求和服务事件，定位超时、鉴权、路由或服务端错误。 页面：`/cds-settings#http-logs`。

步骤：
1. 读取最近 HTTP 日志并按状态码、耗时和路径筛选
2. 读取同一时间窗口的服务事件和容器状态
3. 对重要接口做最小只读复现并记录 trace
4. 将请求失败关联到鉴权、路由、依赖或应用错误

完成标准：异常请求已定位；关联事件和服务状态一致；复现或排除步骤可重复。

## 代码审查报告

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 审查这次改动`、`/cds 上传审查报告` | 项目代码与部署检查 | `cds-deploy-pipeline/SKILL.md`、`cds-project-scan/SKILL.md` | `cdscli code-review`、`cdscli deployment-run`、`cdscli scan`、`cdscli verify` | 会写入 |

### 项目代码与部署检查

让 Agent 阅读当前代码和部署结构，找出会导致构建、启动、健康检查或安全问题的风险。 页面：`/settings/<项目>`。

步骤：
1. 读取项目技术栈、入口脚本、Dockerfile 和 CDS Compose
2. 对照最近部署记录检查构建与运行假设
3. 检查端口、健康探针、环境变量、依赖和敏感信息边界
4. 按严重度输出问题，并对可安全修复项执行验证

完成标准：关键风险有文件或运行证据；修复建议可执行；至少一条真实构建或运行路径完成验证。

## 工程规划

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 记下这个决策`、`/cds 记一笔债`、`/cds 排进落地计划`、`/cds 看卡在哪` | 记录工程决策、计划与债务 | 本技能 | `cdscli planning`、`cdscli debt` | 会写入 |

### 记录工程决策、计划与债务

在已绑定的 CDS 项目记录有来源的工程事项，读取同一项目的推进状态和债务历史。 页面：`/engineering-planning?project=<项目>`。

步骤：
1. 核对项目与规划能力
2. 按用户明确意图查重并选择登记或提案
3. 提交有稳定来源和请求编号的记录并读回结果

完成标准：项目和记录编号可核对；有明确登记或待确认的结果；重复提交可读回原记录与状态。

## 设计

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 帮我设计一个页面`、`/cds 为 xx 提出设计`、`/cds 改 xx 模块的设计`、`/cds 修复 xx 页面的设计`、`/cds 出一版新设计` | 发布设计稿件和框架 | `cds-design/SKILL.md`、`reference/design-loop.md` | `cdscli design`、`cdscli framework` | 会写入 |
| `/cds 帮我实现 DSN-xxx`、`/cds 按交接清单实现` | 六、实现方：按交接清单实现 | `reference/design-loop.md`「六、实现方：按交接清单实现」 | — | 见文档 |

### 发布设计稿件和框架

把工作区的设计交付内容归档到当前 CDS 项目，保留可追溯版本。 页面：`/design?project=<项目>`。

步骤：
1. 读取 cds-design 技能，运行 cds/scripts/skill-fresh.mjs 检查版本，读取当前项目设计接入清单，缺发布授权时先申请
2. 发布框架时使用已有本项目设计发布授权，调用 cds_design_framework_publish 或 cdscli framework publish，按最新版本续发并回读回执
3. 以接入清单 requirements 中指定标识的已确认原文为输入；需要补充时，在同一需求内回复并提出具体问题
4. 读取所属系统、模块、已采用的框架版本及该稿的未关闭反馈；有歧义先在原处澄清，再按稳定稿件键查重
5. 用 cdscli design preview --dir 在与 CDS 相同的沙箱中检查画面，再把窗口尺寸、变更和待核对项写进交付资料
6. 核对当前工作树，只在本地提交用户授权的稿件目录
7. 发布前运行 CDS 技能的 scripts/design/release.mjs check，门禁不通过不发布
8. 用 cds_design_publish 的 sourceMode=private 或 cdscli design publish --private 提交项目私有归档，回读稿件和版本，再用 release.mjs register 登记版本
9. 核对固定版本的交接检查回执，按失败步骤修正并在原稿续版

完成标准：在服务端核对项目、来源提交和归档摘要；同稿修订可读回原编号和新增版本；把稿件地址交给用户（release.mjs register 会打印），稿件发布前不改正式代码。

## 接入 Agent

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 给智能体授权`、`/cds 提权到另一个项目` | Agent 授权与提权 | 本技能 | `cdscli connect`、`cdscli project`、`cdscli env`、`cdscli key` | 含删除、覆盖或回滚，执行前要明确授权 |

### Agent 授权与提权

先静默复用已有凭据，只有缺少目标项目权限时才申请授权；跨项目长期操作必须明确提权。 页面：`/cds-settings#access-keys`。

步骤：
1. 运行 cdscli auth check，再用 cdscli project show <projectId> 验证目标项目权限
2. 同一 CDS 主机和目标项目都验证通过时直接继续，不要求用户重复认证
3. 缺少目标项目权限时才运行 connect --project <projectId> 并等待页面批准
4. 确需长期跨项目时，引导用户在 CDS 系统设置的 AI Access Key 中明确选择授权范围

完成标准：目标项目的只读检查通过；实际权限范围与用户预期一致；本地凭据只保存在当前仓库的 .cds/credentials.json 且不进入 Git。

## 提交缺陷

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 提交一个 CDS 缺陷` | 反馈缺口给上游 CDS 团队 | `SKILL.md`「反馈缺口给上游 CDS 团队」 | — | 见文档 |

## CDS 系统设置

| 你可以说 | 任务 | 先读 | 命令 | 风险 |
| --- | --- | --- | --- | --- |
| `/cds 配登录和 SSO` | 登录与 SSO 认证 | 本技能 | — | 会写入 |
| `/cds 接 GitHub` | GitHub 接入 | 本技能 | — | 会写入 |
| `/cds 更新或重启 CDS` | CDS 更新与维护 | 本技能 | `cdscli disk`、`cdscli health`、`cdscli auth`、`cdscli self` | 含删除、覆盖或回滚，执行前要明确授权 |
| `/cds 改系统设置` | CDS 系统设置 | 本技能 | `cdscli peer` | 含删除、覆盖或回滚，执行前要明确授权 |

### 登录与 SSO 认证

识别身份提供方、准备回调与票据配置，用户只处理受保护的密钥输入和明确授权。 页面：`/cds-settings#auth`。

步骤：
1. 读取 /api/auth/status 与脱敏后的 /api/auth/sso/config
2. 识别当前认证模式和已登录身份，已生效时不重复修改
3. 需要配置时准备身份提供方、回调地址和默认返回页
4. 保存后完成退出、登录和返回 /project-list 的闭环验证

完成标准：认证状态接口返回预期模式；登录闭环成功；回调与默认返回页正确。

### GitHub 接入

检查 GitHub App、仓库授权与 Webhook 状态，用户只完成平台侧确认。 页面：`/cds-settings#github`。

步骤：
1. 读取 GitHub OAuth、App 和 Webhook 的脱敏状态
2. 核对回调地址、仓库范围和最小权限
3. 完成平台侧授权后验证仓库读取
4. 触发或检查一条 Webhook 记录确认事件链路

完成标准：目标仓库可读取；Webhook 有真实事件记录；私有仓库授权范围正确。

### CDS 更新与维护

读取实例状态、准备更新方案，并通过明确授权流程执行高风险操作。 页面：`/cds-settings#maintenance`。

步骤：
1. 读取当前版本、目标版本和实例健康状态
2. 确认更新来源、影响范围与回滚条件
3. 获得明确授权后执行更新或重启
4. 验证版本、健康状态和公开入口

完成标准：目标版本运行；健康检查通过；公开入口和核心接口可访问。

### CDS 系统设置

理解 CDS 系统设置分区，读取现状并完成最小、安全、可验证的配置变更。 页面：`/cds-settings`。

步骤：
1. 定位正确的 CDS 系统设置分区
2. 读取当前值和来源
3. 解释影响范围后执行最小变更
4. 重新读取并验证生效状态

完成标准：配置保存成功；运行时读取到新值；未影响无关项目。
