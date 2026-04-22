| feat | prd-api | 新增 `AgentApiKey` 模型 + `agent_api_keys` 集合 + `IAgentApiKeyService`：为 AI / Agent 提供带 scope 的长效 M2M API Key（默认 365 天 + 7 天宽限期 + UI 续期），明文仅创建时返回一次 |
| feat | prd-api | `ApiKeyAuthenticationHandler` 扩展：识别 `sk-ak-` 前缀走 AgentApiKey 路径，附带 scope claim + 过期/宽限期响应头（`X-AgentApiKey-ExpiringSoon` / `X-AgentApiKey-Expiring`） |
| feat | prd-api | 新增 `RequireScopeAttribute` 端点级 scope 授权过滤器 |
| feat | prd-api | 新增 `/api/open/marketplace/skills/*` 开放接口（list / 详情 / tags / fork / upload / favorite），scope = `marketplace.skills:read` 或 `marketplace.skills:write` |
| feat | prd-api | 新增 `/api/agent-api-keys` 用户管理接口：list / create / PATCH / renew（续期一年）/ revoke / delete |
| feat | prd-admin | 海鲜市场顶部新增「接入 AI」按钮 + `SkillOpenApiDialog`（我的 Key / 新建 Key / 使用指南 三 Tab），支持 scope 勾选、TTL 选择、明文一次性展示、curl/TS/Python 代码样本 |
| feat | prd-admin | 百宝箱新增条目「技能市场开放接口」（`builtin-skill-marketplace-openapi`，`wip: true`） |
| feat | . | 新增 `.claude/skills/findmapskills/SKILL.md`：让 AI 通过开放接口搜索并下载本平台海鲜市场的技能（与 `find-skills` 搜公共生态互补） |
| feat | prd-api | 新增 `/api/official-skills/{skillKey}/download`：平台官方技能包动态 zip 端点，匿名可访问；内置 `marketplace-openapi` 客户端技能（SKILL.md + README，{{BASE_URL}} 运行时替换） |
| feat | prd-admin | 「接入 AI」面板改用液态大玻璃效果（线性渐变 + blur(40px) saturate(180%) + 内光反射）呼应项目设计语言 |
| feat | prd-admin | 「接入 AI」面板首次打开自动下载官方技能包 + Guide/Keys/Create Key 三处均可见显式「下载技能包」按钮；消除"没技能包不知道怎么用"的认知缺口 |
| feat | prd-admin | CreateKeyTab 明文展示态新增「复制给智能体使用」按钮：一段完整提示词，粘贴到 Claude Code / Cursor 后 AI 自动 `export` 环境变量 + 下载解压官方技能包 |
| feat | prd-api | P3 基础设施：新增 `AgentOpenEndpoint` Model + `agent_open_endpoints` 集合 + `/api/admin/agent-open-endpoints` Admin CRUD —— 每个 Agent 可登记 HTTP 开放接口（路径、方法、所需 scope、白名单） |
| feat | prd-api | P3：`AgentApiKeysController` scope 白名单扩展为"固定 + 动态"：固定 `marketplace.skills:*`，动态接受正则 `agent.{key}:{action}` 且 scope 必须已被某条 `AgentOpenEndpoint` 登记 |
| feat | prd-api | P3：`MarketplaceSkill` Model 新增 `ReferenceType` (`zip` \| `open-api-reference`) + `ReferenceEndpointId` 字段，为"Agent 开放接口自动桥接到海鲜市场技能引用"铺路（自动桥接逻辑待后续实现） |
| refactor | prd-admin | 「接入 AI」弹窗 Tab 重构为 [新建接入 / 我的 Key / 使用指南] 三页：落地页只有两个大卡片（手动接入 → 跳使用指南；智能体接入 → 切 Keys Tab + 自动展开带 agent 模式的新建表单，主 CTA 变为"复制给智能体使用"）。合并原"新建 Key"独立 Tab 到"我的 Key"内联展开。移除首次打开自动下载行为（改为纯手动点击）|
| refactor | prd-api | 官方技能包 key 由 `marketplace-openapi` 重命名为 `findmapskills`，SKILL.md 模板整合为海鲜市场全操作手册（搜索/下载/上传/收藏/订阅/Key 过期处理一揽子），对应 `GET /api/official-skills/findmapskills/download` |
| refactor | prd-admin | 「复制给智能体使用」提示词精简并加固安全：仅 3 步 —— 把 Key 写进 `~/.zshrc`/`~/.bashrc`（不入仓）+ 一行 curl 下载 findmapskills 到 `~/.claude/skills/` + 让 AI 读 SKILL.md 自学；移除原 verbose 版多步骤说明 |
| fix | prd-admin | 「新建接入」落地页样式调优：推荐卡片从高饱和紫色改为青蓝半透明（和液态玻璃面板融合），新增「3 步时间线」+「安全 & 生命周期双栏」填充下半部空白，消除"大面板底部黑洞"视觉缺陷 |
| docs | . | 补齐交接清单 P1 文档：`doc/rule.data-dictionary.md` 追加 `agent_api_keys` + `agent_open_endpoints` 两集合 · 新建 `doc/design.skill-marketplace-open-api.md` 覆盖架构/scope 契约/Key 生命周期/P3 演进路线 · `.claude/rules/codebase-snapshot.md` 集合数 115→117 + 功能注册表补条 |
| feat | prd-api | findmapskills 官方技能接入版本号机制：新增 `FindMapSkillsVersion=1.0.0` + `FindMapSkillsReleaseDate=2026-04-21` 常量；SKILL.md / README 模板顶部加版本号 header + 底部新增「如何更新此技能」章节（3 种触发信号 + 重装 curl 命令）；下载端点自动替换 `{{VERSION}}` / `{{RELEASE_DATE}}` 占位符；`.claude/skills/findmapskills/SKILL.md` 仓库版与后端模板同步 |
| feat | prd-api | findmapskills 虚拟注入到海鲜市场列表：新增 `OfficialMarketplaceSkillInjector` 静态 helper；`MarketplaceSkillsController.List` + `MarketplaceSkillsOpenApiController.List` 在筛选命中时把 `official-findmapskills` 条目 Prepend 到首位；Fork / GetById 端点按 `official-` 前缀特判、不查 DB / 不 +1 count，直接返回 `/api/official-skills/findmapskills/download` 官方下载 URL |
| feat | prd-admin | MarketplaceCard 识别 `ownerUserId === 'official'` 条目，标题右上角展示「🛡️ 官方」青蓝描边徽章（替代普通类型标签），视觉上和普通 zip 技能做区隔 |
| refactor | prd-admin | 「接入 AI」弹窗按日式极简广告原则重排视觉层级：一屏一个主 CTA。StartTab 去掉内嵌「开始」按钮（整张卡片可点）+ 辅助信息压缩为一行灰字足注 + 垂直居中让留白成为构图；CreateKeyTab 表单态与明文态的主按钮都放大为青蓝渐变全宽按钮，次要操作（只复制明文 / 下载技能包 / 返回列表 / 取消新建）全降为灰色文字链；KeysListTab 顶部保留"新建 Key"主按钮（同款渐变），「下载技能包」改为透明描边的幽灵按钮，避免两个同色按钮抢视线 |
| feat | prd-admin | 新增「演示视频」通用基础设施：`homepageAssetSlots.DEMO_VIDEO_SLOTS` 注册表 + `demoVideoSlot()` + `useDemoVideoUrl(id)` hook + AssetsManagePage 对应上传分区（复用 HomepageAsset 后端，无需建新集合）。任何模块只需 1 行登记 + 1 个 hook 就能在 UI 关键步骤嵌入实拍/录屏演示；未上传时前端自动回退静态占位卡，不阻断功能 |
| refactor | prd-admin | 「接入 AI」弹窗布局三处细节调整：StartTab 改为顶 / 中 / 底三段式（标题 + 两卡片 + 横版 3 步流程条）撑满 88vh 空间；CreateKeyTab 表单态 Key 名称默认随机生成（`接入 YYYY-MM-DD HH:MM · xxxx`）+ 旁边"🎲 换一个"链接 + 删除「备注」字段；权限范围从纵向长条改为 2 列卡片选择器（icon + 标题 + 描述 + 右上圆勾）；明文展示态在 Key 与主 CTA 之间嵌入演示视频（autoplay muted loop）或"待上传"占位卡 |
