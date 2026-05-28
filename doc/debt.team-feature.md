# debt.team-feature

> 类型: debt（工程债务台账） | 状态: active | 模块: 团队（网页托管 + 知识库）
> 创建: 2026-05-25

团队功能（wave 1）已落地核心 11 项需求。本文件登记交付时主动声明的已知边界与后续可补项，避免下一次 session 无人记得。

## wave 2 进行中：网页托管角色细分（owner/editor/viewer）

2026-05-26 起，网页托管团队共享层把决策 10「成员全员平等」细分为三角色（知识库仍按决策 10 不变）：

- 模型：`TeamMember.WebHostingRole`（nullable，仅网页托管消费）。null = 继承（admin→owner / member→editor），存量成员零降权迁移；显式设 viewer 才只读。
- 策略：`PrdAgent.Core.Security.WebHostingPermission`（纯函数）+ `TeamService.GetMyWebHostingTeamRolesAsync`。`HostedSiteService` 的 Update/Reupload/Delete/BatchDelete/CreateShare 已接角色门控；Get/List 读路径不变（viewer 可读）。
- 能力矩阵：viewer 只读；editor 读+编辑+重传+建分享（**不能删别人创建的站点**）；owner（团队管理员默认映射）全开；站点创建者对自己的站点恒为 owner。

### 已落地（Phase 1 地基 + Phase 2 角色管理）
- **角色可设**（Phase 2）：`PUT /api/teams/{id}/members/{userId}/web-hosting-role`（仅团队管理员可调，团队创建者恒 owner，role=null 重置继承）。团队管理面板成员行新增「网页托管角色」选择器；网页托管团队视图按 `myWebHostingRole` 隐藏 viewer 的编辑/删除/分享/设公开入口 + 批量操作门控 + 顶部「我的权限」角标。`GET /api/teams/{id}` 返回 `webHostingRoles` 映射，`GET /api/web-pages?scope=team` 返回 `myWebHostingRole`。
- **删除行为变化**：细分前任意成员可删团队内任意站点；现在普通成员(editor)只能删自己创建的，删别人的需 owner（团队管理员或站点创建者）。这部分缓解了下面边界 #1 的「恶意删」风险，但回收站仍未做。

### 仍未覆盖（wave 2 续作）
- **写路径拒绝返回 404**：viewer/非成员尝试 Update/Delete 时服务返回 null→控制器 404（不泄露存在性）；CreateShare 返回 403。UI 已按角色隐藏入口，404 仅作纵深防御兜底。
- **「分享到团队」批量入口在团队作用域隐藏**：setSiteTeams 后端仅站点创建者可调，团队视图里对非创建者会逐条失败，故只在个人作用域显示该批量按钮。
- **知识库未跟进**：本次只动网页托管，知识库仍按决策 10 全员平等。
- **后端编译**：本地无 dotnet SDK，C# 编译由 CDS 灰度构建验证；前端 `pnpm tsc --noEmit` + `eslint` 改动文件零告警已本地跑通；纯单测 `WebHostingPermissionTests` 走 CI，本地未执行。

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

---

## wave 2.5：直接添加成员 + 退出团队 + 解散移入文件夹（2026-05-28，PR #682）

用户明确反馈「邀请就是直接同意就行，链接邀请不合适，应该用公共用户组件让用户多选点击邀请，然后自动同意进来；还有退出和解散，退出就是成员移除，解散就是托管会默认移动到 owner 的主分支的同名文件夹团队文件夹下」。本次落地，完整覆盖。

### 已落地
- **多选直接添加**：三处入口（`TeamScopeBar` banner / `SpaceBar.TeamSpaceHeader` / `TeamManagerPanel`「添加成员」tab）全部走「搜索 + 多选 + 确认添加」，调用 `POST /api/teams/{id}/members` 批量入组，自动同意无需对方确认。**完全移除邀请链接 UI**（旧 `inviteLink` / 复制按钮 / 重置链接全删）。
- **退出团队**：`TeamManagerPanel` 右上角新增「退出」按钮，仅对非 owner 成员可见（owner 看到「解散团队」红字按钮）。逻辑：`DELETE /api/teams/{id}/members/{self}`；owner 自退被后端 `RemoveMember` 的 `if (memberUserId == team.OwnerUserId) return BadRequest("不能移除团队创建者")` 拦截。
- **解散文件夹归属**：`DELETE /api/teams/{id}` 解散逻辑改造为按 `OwnerUserId` 分支：owner 的托管站点 `HostedSite.Folder = "{团队名} 团队解散文件夹"`（同时拉掉 `SharedTeamIds`），其他成员站点仅拉掉 `SharedTeamIds` 回各自个人空间。前端 confirm 文案明确告知文件夹归属。
- **TeamManagerPanel 支持 initialTab/initialTeamId props**：外部入口（如 SpaceBar 邀请按钮）可指定打开后直接落「添加成员」tab。

### 已知边界
- **直接添加成员不通知对方**：无站内消息推送，对方下次刷新左侧 SpaceBar 才看到新团队 chip。未来若加站内通知系统补「你被添加进 {team}」消息。
- **解散文件夹仅对 owner 站点生效**：其他成员的站点解散时仅移除团队引用，回到各自个人空间，不放进任何文件夹（设计如此——非 owner 没有"我的解散文件夹"概念）。文档化避免未来产生疑问。
- **owner 不能"退出"自己的团队**：API 层拦截"创建者退出"，前端隐藏「退出」按钮。如需转让所有权，需先在 wave 3 加 `TransferOwnership` 端点。
- **解散无回收站**：与 wave 1 边界 #1 同源（团队回收站未实现），解散后 owner 文件夹里的站点是真实站点（可恢复回团队），但活动日志/分享链记录会全部删除。

### 验证证据
完整验收报告归档：`https://dreamy-brahmagupta-mumfb-claude-prd-agent.miduo.org/s/lib/QLs14tp7PtH5`
- 10/10 用例 PASS（创建/多选添加/退出拦截/非 owner 退出/解散文件夹 confirm 文案 等）
- 截图存放 `/tmp/acc_team_shots/`，driver 脚本 `/tmp/team-driver.mjs`
