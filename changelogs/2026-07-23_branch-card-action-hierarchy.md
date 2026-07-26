| polish | cds | 调整分支卡片预览与一键启动按钮的视觉层级 |
| fix | cds | 修复分支卡片提交历史浮层遮挡当前提交摘要的问题 |
| polish | cds | 使用 Shiny Text 重构 AI 操作分支卡片的标题与状态动效 |
| fix | cds | CDS 专属分支自动优先匹配 CDS Self 预览项目，避免误开业务项目 |
| polish | cds | 重构侧栏用户菜单与右下角更新、授权提醒层级 |
| feat | cds | 新增可配置的一次性票据 SSO，和密码登录并存，登录后默认进入主分支项目列表 |
| feat | prd-api | 新增数据库单次消费的通用控制台 SSO 提供方接口，供 CDS 等外部控制台安全换票 |
| feat | cds | 新增全局常驻的上下文感知 Agent 接入入口，并支持在登录与认证页直接交给 Agent 配置 |
| feat | cds | 将 Agent 项目与任务选择重构为可探索的接入地图，切换地图地标即可生成对应操作上下文 |
| fix | cds | 避免预览实例的分支状态条遮挡常驻 Agent 接入入口 |
| polish | cds | 保留 Agent 接入原流程，将当前任务改为可展开的大洲与地界世界地图选择器 |
| polish | cds | 撤除 Agent 地图隐喻，将任务选择简化为一排 N 个清晰的任务卡片 |
| feat | cds | 将接入 Agent 升级为集中维护的 CDS 操作任务库，支持分类排障、静默认证与跨项目提权指引 |
| feat | cds | 建立覆盖全部接口模块族的 Agent 能力目录并补齐完整五技能包协作更新 |
| security | cds | 增加凭据来源脱敏检查、提示注入防护、操作锁与环境变量元数据读取 |
| fix | cds | 修复接入 Agent 弹窗在移动端的页签横向裁切 |
| security | cds | 修复 SSO-only 鉴权绕过、全局配置越权与 SSO 身份错误获得所有者权限的问题 |
| fix | cds | 修复 SSO 会话识别、退出跳转、默认返回页和回调地址协议校验 |
| fix | cds | 修复 Agent 跨项目任务上下文、项目深链和项目列表刷新问题 |
| fix | prd-api | 增加 Bearer 感知的控制台 SSO 授权承接流程并校验允许的回调来源 |
| fix | prd-admin | 新增控制台 SSO 授权承接页面 |
| test | prd-api | 固定模型供应限流测试时钟，消除跨分钟边界导致的 CI 假失败 |
| security | cds | 阻止环境托管 SSO 配置落库并区分本地所有者与 SSO 人工会话 |
| fix | cds | 修复 SSO-only 登录表单、StrictMode 回调换票与系统任务错误借用业务项目 |
| fix | cds | 修复重复凭据误报冲突，并在项目级凭据下安全解析 CDS Self 预览 |
| fix | prd-api | 允许已配置来源的 loopback HTTP 完成本地 SSO 回调 |
| security | cds | 将 SSO 回调锁定到规范公网地址，并为换票请求增加超时与可用性错误分类 |
| fix | cds | 关闭 Agent 接入对话框或跨页时清除显式任务上下文 |
| security | cds | 限制 SSO 完整配置仅系统所有者可读，并在 SSO 退出时统一清理所有登录会话 |
| security | cds | 为预览 SSO 保留可信公网回调地址，并限制未消费登录 state 的数量与清理开销 |
| security | cds | 拒绝含反斜杠的 SSO 返回路径，阻止浏览器规范化造成的跨域跳转 |
| fix | cds | 让 basic 模式的身份端点沿用认证门结果并支持 X-CDS-Token 请求头 |
| security | cds | SSO 登录 state 满额时拒绝新请求并保留全部仍有效的授权流程 |
| fix | cds | Agent 任务调度上下文携带并消费明确的项目标识 |
