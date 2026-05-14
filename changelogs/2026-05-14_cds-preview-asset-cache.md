| fix | cds | 调整预览分支静态资源缓存策略，避免最新提交页脚与旧前端 chunk 混用 |
| fix | prd-admin | 为生产静态服务补充资源缓存配置，避免预览页继续使用旧构建 chunk |
| fix | prd-admin | 前端构建产物文件名加入构建 ID，避免同名 chunk 被浏览器或边缘缓存复用 |
| fix | prd-admin | 远端构建显式注入构建 ID，避免无 git 环境下退回固定资源名 |
| feat | prd-api | 为 CDS Agent 会话新增消息列表 API，支持对话页恢复用户与 Agent 消息 |
| feat | prd-admin | CDS Agent 独立页新增对话 transcript 区，区分多轮消息与事件时间线 |
| feat | prd-api | 新增远程仓库 PR 创建工具，允许 CDS Agent 在审批后提交分支并创建 GitHub PR |
| fix | prd-admin | CDS Agent 会话按钮按状态显示启动、重试和继续，避免失败会话直接发送到旧 runtime |
| fix | prd-api | CDS Bridge 远程导航默认拦截 localhost、内网、链路本地和 metadata 地址 |
| feat | prd-admin | CDS Agent 事件时间线新增回放模式，支持按步骤复盘远程执行事件 |
| feat | prd-api | CDS Agent 系统级模型配置支持覆盖更新，避免重复创建临时配置 |
| feat | prd-admin | CDS Agent 页面新增更新当前模型配置入口，重新保存 API key 后长期复用 |
| feat | prd-admin | CDS Agent 工作台新增会话、失败、事件、工具和产物指标条，提升运行可观测性 |
| feat | prd-admin | CDS Agent 工作台新增审计摘要，展示会话用户、连接、模型配置、工具策略和凭据暴露状态 |
| feat | prd-api | CDS Agent 新增事件 schema 清单接口，稳定 status/text/tool/log/error/done/hook/file/diff/browser 事件契约 |
| feat | prd-admin | CDS Agent 审计摘要展示当前会话事件类型覆盖，便于工作流和智能体消费事件 |
| feat | prd-admin | CDS Agent 对话输入区新增文件路径、网页地址、项目文档和知识库上下文入口 |
| feat | prd-api | CDS Agent 会话新增人工接管状态和人工输入接口，暂停自动发送时仍可持久化操作记录 |
| feat | prd-admin | CDS Agent 工作台新增人工接管面板，支持暂停 Agent、记录人工输入并继续工具审批 |
| feat | prd-api | CDS Agent 模型配置新增 CPU、内存、超时、网络策略和自动清理资源边界并固化到会话 |
| feat | cds | CDS Agent 会话记录 MAP 下发的资源策略，并在事件、日志和会话视图中返回 |
| feat | prd-admin | CDS Agent 模型配置表单新增资源边界设置，并在审计摘要中展示会话固化策略 |
| feat | prd-api | CDS Agent 停止会话时新增 stopping 中间态和状态事件，便于刷新恢复与审计 |
| feat | cds | CDS Agent 停止接口补充 stopping 状态事件和日志，与 MAP 会话状态机对齐 |
| fix | prd-api | CDS Agent 停止会话接口补齐业务异常映射，避免授权撤销等失败被包装成 500 |
| feat | prd-admin | CDS Agent 工作台展示远程页面安全边界和 Bridge 工具拦截规则 |
| feat | prd-admin | CDS Agent 工作台展示 Git 状态、diff 和创建 PR 工具的审批规则 |
| feat | prd-api | 工作流运行器将 CDS Agent 节点纳入长任务事件透传，运行页可收到远程会话阶段事件 |
| feat | prd-api | CDS Agent 智能体执行器改为边执行边输出阶段事件，并回填事件时间线与运行日志产物 |
| fix | prd-api | 统一 CDS 连接有效状态判断，避免列表显示可用但会话创建仍按已撤销拒绝 |
| fix | prd-api | CDS Agent 运行配置读取忽略未知字段，避免历史/未来配置字段阻断智能体执行 |
| fix | prd-api | CDS Agent 智能体执行器在远程会话失败时保留日志产物并将 run 标记为失败 |
| fix | prd-api | CDS Agent 智能体执行器复用系统运行配置服务读取默认模型，避免绕过服务层触发 BSON 兼容问题 |
| fix | prd-api | CDS Agent 智能体执行器增加运行配置 BSON 兜底读取，保证历史字段异常时仍能继续远程会话链路 |
| fix | prd-api | CDS Agent 智能体执行器在创建远程会话前输出配置解析阶段并包装早期失败原因 |
| feat | prd-api | 百宝箱 run 在每个步骤开始后输出实际调度的智能体适配器名称，便于远程执行诊断 |
| fix | prd-api | PRD Agent API 的 DataProtection key ring 改存 MongoDB，避免系统级 CDS 长期授权在容器重建后失效 |
| fix | cds | CDS 连接 accept 回调改为一次性 pairing token 鉴权路径，避免 MAP 粘贴授权被 CDS 登录态拦截 |
| fix | prd-api | 百宝箱 CDS Agent 执行队列切到 v2，避免旧预览 worker 抢消费后提示未找到 cds-agent |
| feat | cds | CDS shared-service 实例发现支持返回分支服务 baseUrl，用于系统级 sidecar pool |
| feat | prd-api | CDS Agent sidecar 改为通过长期授权连接动态发现系统级 sidecar pool |
| fix | prd-api | Agent 工具回调鉴权接受 CDS 系统级 sidecar pool 的共享 token |
