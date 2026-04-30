| feat | cds | 将分支列表主入口迁到 React：新增 `/branches/:projectId`，旧 `/branch-list?project=<id>` 兼容进入同一页面；项目卡片“进入项目”改走新语义路径 |
| feat | cds | React 分支页围绕快速预览重做主链路：右侧远程分支点击一次即可创建跟踪分支、SSE 部署并按当前预览模式打开 URL；点击时先打开占位标签，部署完成后跳转，避免浏览器拦截异步弹窗；已跟踪分支支持预览、部署/重部署、拉取、停止 |
| feat | cds | React 分支卡片补齐高频管理操作：收藏、tag 编辑、调试标记、错误状态重置、删除分支；删除会先弹确认，再消费后端 DELETE SSE 流并刷新列表 |
| feat | cds | 分支列表补齐多分支操作效率：同一搜索框同时筛已跟踪与远程分支，收藏分支置顶，新增运行/忙碌/异常/收藏快筛、排序、紧凑模式，以及批量部署、批量拉取、批量停止运行中、批量收藏、批量重置异常、批量删除一次确认 |
| feat | cds | 新增 React 分支详情页 `/branch-panel/:branchId`：展示服务状态、构建日志、容器日志、有效 profile 配置和最近提交；支持单服务重部署、运行时诊断、强制干净重建确认 |
| feat | cds | React 分支详情页的有效配置卡片支持常用 profile override 编辑：覆写命令、镜像、端口、路径前缀，以及恢复公共配置；保存后提示重新部署生效 |
| feat | cds | React 分支详情页补齐运维入口：预览别名编辑、历史 commit 固定/恢复、当前分支 HTTP 转发日志；会改变 worktree 指向的固定/恢复操作都先弹确认 |
| feat | cds | React 分支详情页新增 Bridge 面板：可激活/结束会话、查看 Widget 连接状态、读取页面状态；不暴露任意 click/type 遥控命令 |
| feat | cds | `/branch-panel` 接管为 React 详情页时曾临时保留 `/branch-topology?project=<id>` 拓扑入口，后续继续迁入 React 以避免能力断层 |
| feat | cds | `/branch-topology?project=<id>` 已迁到 React 简化拓扑，展示应用服务、基础设施、分支运行状态、依赖和跳转入口 |
| test | cds | 扩展 server-integration 路由契约：确认 `/branches/:projectId`、`/branch-list`、`/branch-panel`、`/branch-topology` 都由 React 接管，`/api/*` 不被 shadow |
| test | cds | 修正分支 API 测试的 default 前提：legacy default 行为由测试显式 seed，不再依赖 fresh install 自动创建空 `default` 项目 |
| docs | cds | 新增 Week 4.5 功能差距收敛计划：删除旧前端前先借鉴 legacy 分支页/拓扑页的必要运维能力，且删除 `web-legacy/` 必须等待用户明确确认 |
| refactor | cds | 调整 React 分支页功能层级：快速预览支持粘贴任意分支名，容量状态和批量运维移到右侧面板，单分支低频操作收进“更多操作”，并在部署前加入容量超限确认 |
| fix | cds | 优化分支页桌面布局：`lg` 起固定右侧运维栏，分支卡片保持单列，`2xl` 才恢复双列，避免功能层级正确但位置掉到页面下方 |
| fix | cds | 分支部署动作新增耗时和最近 SSE 步骤；部署流正常结束但分支进入异常时，卡片显示失败摘要，不再误报“部署完成” |
| polish | cds | 异常分支卡片新增可操作失败建议：突出失败服务，直接提供“看详情”和“重置异常”，避免只显示红色状态让用户猜下一步 |
| feat | cds | 分支页右侧新增“最近活动”，订阅 `/api/activity-stream` 展示 CDS/Web/API 事件，先替代旧页悬浮 Activity Monitor 的核心排错信息 |
| feat | cds | 分支页右侧运维状态新增容量预估：勾选分支后提前显示预计新增容器与剩余容量，容量不足时在批量部署前明确提示 |
| feat | cds | 分支页右侧新增“执行器”状态卡，读取集群模式、在线节点、空闲容量和主执行器；轮询带 `X-CDS-Poll` 避免污染活动流 |
| feat | cds | 分支页右侧运维栏补主机健康与容量腾挪：读取 `/api/host-stats` 展示 CPU/内存/uptime，容量不足时可一键停止较旧运行分支腾出容量 |
| feat | cds | 分支页执行器卡升级为节点列表，展示每个执行器的分支数、CPU、内存，并提供带确认的排空与移除入口 |
| feat | cds | 分支页 Activity Monitor 补 API/Web/AI 筛选和“复制摘要”，排查自动化触发、预览访问和 API 失败时不用再翻旧悬浮面板 |
| feat | cds | 分支页 Activity Monitor 补按具体分支筛选和内联详情面板，可查看 method/path/status/duration/source/branch/profile/body 并复制摘要 |
| refactor | cds | 右侧栏顺序调整为快速预览 → 远程分支 → 运维状态 → 执行器 → 批量运维 → 最近活动，避免一键预览入口被运维信息压低 |
| feat | cds | 分支详情页新增“失败诊断”：异常分支首屏汇总失败服务、配置缺失和最近错误步骤，并给出补命令、看日志、运行诊断、重部署入口 |
| fix | cds | 分支详情页运行时诊断改为可读摘要；后端在容器不存在或未运行时返回明确 400，避免 `No such container` 被包装成“诊断完成” |
| fix | cds | `exec_cds.sh` 的后端/前端构建缓存不再只看 Git HEAD；本地源码或 web 源码有未提交改动时会重新构建，避免预览服务继续使用旧 dist |
| feat | cds | 分支详情页提交历史补搜索、最新/当前/已固定标识；当前提交不可重复固定，固定状态下最新提交提供“恢复最新”入口 |
| feat | cds | 分支详情页动作日志区分运行中/完成/失败并支持复制；force rebuild 部分失败时显示失败状态和重试/重部署建议 |
| feat | cds | 分支详情页 HTTP 转发日志改为订阅 `/api/proxy-log/stream` 实时追加当前分支记录，并补筛选、异常/慢请求摘要、upstream/耗时/提示展示 |
| feat | cds | React 拓扑页应用服务节点详情补 `详情 / 分支 / 路由 / 变量` tab，并加载项目路由规则展示服务相关入口 |
| feat | cds | React 拓扑页分支选择器补搜索；无匹配时提供“创建/部署分支”入口回分支列表主链路，保留共享视图/单分支视图切换 |
| polish | cds | React 拓扑页补第一轮控制台视觉打磨：顶部摘要条、分支上下文工具条、节点状态图标/运行计数/路由标签、sticky 详情面板和默认节点选中，降低“无 CSS 感” |
| feat | cds | React 拓扑页应用服务节点详情新增“日志 / 提交”tab：单分支视图复用分支详情 API 读取构建事件、容器日志和最近提交，日志可复制，提交固定/恢复仍跳分支详情页处理 |
| polish | cds | React 拓扑页补第二轮信息层级：分支选择同步 URL，新增当前视图状态条和预览/详情入口，服务节点补运行覆盖条，详情 tabs 在窄栏下保持规整 |
| fix | cds | `exec_cds.sh init` 不再询问是否启用 MongoDB；新初始化自动启用 `mongo-split`，Mongo 启动失败直接失败，不再静默退回 JSON/state.json |
| polish | cds | `/branches/:projectId` 首屏改为“分支控制台”：统计、粘贴分支预览、项目/设置/拓扑入口统一放到顶部，右侧栏从远程分支开始，分支卡改为行式操作卡并复用 `MetricTile` |
| polish | cds | `/branches/:projectId` 视觉第二轮：顶部合并为一键预览控制台，分支卡固定为“身份 / 指标 / 操作”三栏，主按钮不再在桌面窄宽下错位换行 |
| polish | cds | 举一反三修复 React 迁移版“未完成品感”：移除全屏网格背景，分支页取消宽屏双列假响应式；项目页、分支页、分支详情、拓扑、项目设置和系统设置页收敛到居中控制台工作区，并把标题、工具条、表单和列表行纳入同一视觉层级 |
| polish | cds | `/branches/:projectId` 默认视图减负：筛选/排序/批量、容量、主机、执行器和活动流默认折叠；分支卡移除独立指标列，只保留预览、详情、部署和更多操作 |
| polish | cds | `/branch-panel/:branchId` 默认视图减负：构建日志、容器日志、有效配置、Bridge、提交历史和 HTTP 转发日志收进折叠面板，默认只暴露服务状态和主操作 |
| polish | cds | `/branch-topology` 节点详情减负：取消默认六 tab 详情面板，改为摘要、状态、主操作和统一折叠的配置/分支/路由/变量/日志/提交 |
| polish | cds | `/cds-settings#maintenance` 默认聚焦自更新主链路，SSE 日志、镜像外观和危险操作默认折叠 |
| refactor | cds | 新增共享 `DisclosurePanel`，分支详情、拓扑节点详情和维护页统一折叠面板样式，避免后续页面继续复制局部 details 结构 |
| polish | cds | `/project-list` 首屏继续减负：顶部只保留新建/刷新/待处理 Agent 申请，技能包、全局 Key、Agent 记录收进“自动化工具”；项目列表从横向长行改为卡片网格，设置、Agent Key 和删除默认折叠到项目卡“管理” |
| polish | cds | 分支部署排错闭环第一轮：部署动作卡展示阶段、耗时、最近步骤、失败建议和可复制排错摘要；分支详情动作日志失败时同步给下一步建议 |
| polish | cds | `/branch-topology` 补粘贴分支预览入口，提交后跳回 `/branches/:projectId?preview=<branch>` 复用分支控制台的一键创建、部署和打开预览链路 |
