# debt.team-feature

> 类型: debt（工程债务台账） | 状态: active | 模块: 团队（网页托管 + 知识库）
> 创建: 2026-05-25

团队功能（wave 1）已落地核心 11 项需求。本文件登记交付时主动声明的已知边界与后续可补项，避免下一次 session 无人记得。

## wave 2 进行中：网页托管角色细分（owner/editor/viewer）

2026-05-26 起，网页托管团队共享层把决策 10「成员全员平等」细分为三角色（知识库仍按决策 10 不变）：

- 模型：`TeamMember.WebHostingRole`（nullable，仅网页托管消费）。null = 继承（admin→owner / member→editor），存量成员零降权迁移；显式设 viewer 才只读。
- 策略：`PrdAgent.Core.Security.WebHostingPermission`（纯函数）+ `TeamService.GetMyWebHostingTeamRolesAsync`。`HostedSiteService` 的 Update/Reupload/Delete/BatchDelete/CreateShare 已接角色门控；Get/List 读路径不变（viewer 可读）。
- 能力矩阵：viewer 只读；editor 读+编辑+重传+建分享（**不能删别人创建的站点**）；owner（团队管理员默认映射）全开；站点创建者对自己的站点恒为 owner。

### 本阶段已知边界（Phase 1 地基，wave 2 续作）
- **角色暂不可设**：尚无「设置成员网页托管角色」端点 + 管理 UI（ManageRoles 能力已在策略里预留）。因此当前所有成员都走继承默认，**viewer 角色暂不可达**，唯一对外可见的行为变化是「普通成员不再能删除别人的站点」。设置 UI/端点是 Phase 2。
- **删除行为变化**：细分前任意成员可删团队内任意站点；现在普通成员(editor)只能删自己创建的，删别人的需 owner（团队管理员）。这部分缓解了下面边界 #1 的「恶意删」风险，但回收站仍未做。
- **写路径拒绝返回 404**：viewer/非成员尝试 Update/Delete 时服务返回 null→控制器 404（不泄露存在性）；CreateShare 返回 403。UI 应按角色隐藏操作入口，404 仅作纵深防御兜底。
- **后端编译**：本地无 dotnet SDK，C# 编译由 CDS 灰度构建验证；纯单测 `WebHostingPermissionTests` 走 CI，本地未执行。

### 1. 团队回收站（软删除，E3）未实现
决策 10「全员可删除」下，团队成员误删/恶意删会直接毁掉别人内容，无回收站兜底。
- 网页托管已部分缓解：删除收敛到 owner / 站点创建者（见上）；知识库仍是全员可删。
- 当前：删除即物理删除（与个人版一致）。
- 建议（紧邻 wave 2 第一项）：给 HostedSite / DocumentEntry 加 `IsDeleted`/`DeletedAt`，团队内容删除走软删 + 30 天回收站视图 + restore 端点。改动面：两模块所有 delete 路径 + list 过滤 `IsDeleted==false` + 回收站 UI。

### 2. 知识库部分次要端点仍 owner-only（未放宽到团队成员）
为控制本次改动面与风险，以下 DocumentStoreController 端点保持「仅 owner」，团队成员暂不可操作共享库的这些动作：
- 订阅管理：`AddSubscription` / `AddGitHubSubscription` / `TriggerSync` / `ListSyncLogs` / `UpdateSubscription`
- 分享链接：`CreateShareLink` / `ListShareLinks` / `RevokeShareLink`（对外分享属所有权动作，与网页托管 SetVisibility 保持 owner-only 一致）
- 划词评论：`CreateInlineComment` / `DeleteInlineComment`（store.OwnerId 校验未放宽）
- AI 加工：`GenerateSubtitle` / `Reprocess` / `GetLatestAgentRun`
- 浏览分析：`ListStoreViewEvents`

已放宽到 owner-or-member 的核心协作端点（决策 10）：列表/详情读、UpdateStore/DeleteStore/SetPrimaryEntry、AddEntry/CreateFolder/UploadFile、UpdateEntry/DeleteEntry/MoveEntry/UpdateEntryContent/ReplaceEntryFile/RebuildContentIndex/SetFolderPrimaryChild/TogglePinnedEntry。

后续若要全面协作，按同样的 `CanWriteStore` 模式逐个放宽，并补对应活动日志埋点。

### 3. 公共团队（Visibility=public）仅留字段，行为未实现
`Team.Visibility` 已支持 private/public，但「public = 团队内容对本应用所有登录用户只读可见」的查询分支未接。当前所有团队按 private 处理。wave 2 再接 public 只读视图。

### 4. 邀请「链接」仅给邀请码，无落地路由
邀请走邀请码（在「管理团队」面板内兑换），未实现 `/join-team/{code}` 落地页路由（刻意走 modal 避开 navCoverage 新路由）。若产品要可点击邀请链接，再加路由并登记 ALLOW_LIST。

### 5. 成员归属头像兜底（users/by-ids）未在所有路径接入
- 网页托管团队列表：后端 `owners` map 已带创建者昵称/头像 → 已覆盖。
- 知识库团队列表：后端 `ownerName`/`ownerAvatarFileName` 已带 → 已覆盖。
- 知识库「条目级」创建者头像（DocumentEntry.CreatedByName/Avatar）：新条目已写快照；**旧条目**缺快照时前端尚未调 `/api/teams/user-cards` 兜底（条目树 UI 未改）。后续接 DocBrowser 时补。

## 验证状态（交付时）
- 前端：`pnpm tsc` 通过 / 新增文件 `eslint` 零告警 / `navCoverage` 测试通过。
- 后端：本地无 dotnet SDK，C# 编译由 CDS 灰度环境验证（push 触发 webhook 自动构建）。push 后须确认 CDS 绿灯 + 预览域名端到端走通团队建/邀请/分享/编辑/活动日志，再视为完成。
