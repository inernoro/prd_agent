# 团队动态 · 债务台账

> **版本**：v1.0 | **日期**：2026-07-31 | **状态**：开发中

**一句话**：团队动态三条线的欠账合成一册：动态时间线本体、团队能力（角色细分与加成员）、行为洞察与旧版用户之声。
**谁该读**：接手团队动态的产品与工程师；关心隐私脱敏口径的人。
**读完能做什么**：按线定位欠账与已定方向。

---

> 本台账由 3 份同模块台账合并而成，内容原样保留、只做归位；原文件已回收，引用已改指本文。

## 主台账

记录团队动态页（/team-activity，团队脉搏面板 + 时间线）的已知边界、后续可补项与留尾。

## 已知边界

| 项 | 状态 | 说明 |
|------|------|------|
| 排行榜按原始动作数计分 | 待解决 | 时间线已折叠连续同类动作，但成员排行仍按未去重的原始计数排序——连续触发 50 次图片生成即可刷到榜一。后续应在 stats 聚合中按「折叠后的有效动作」或按 动作类型加权 计分，抑制刷量激励 |
| 小时直方图采样上限 5000 条 | 设计取舍 | /api/team-activity/stats 的 hourlyUtc 基于最近 5000 条投影计算（模块/成员计数为精确聚合）。今天/本周远够用；「全部」大范围时直方图为近似，UI 已标注「近 5000 条采样」 |
| 时区旋转按整小时近似 | 设计取舍 | hourlyUtc 由前端按浏览器时区整小时旋转（rotateHourlyToLocal），半小时时区（如 UTC+5:30）有 30 分钟偏差 |
| 环比窗口为「同长上一窗」 | 设计取舍 | 今天 vs 昨天同窗（截至当前时刻的等长窗口）、本周 vs 上周同窗；「全部」范围无环比。未做节假日/工作日校准 |
| 动态无深链下钻 | 待解决 | ActivityLog.TargetUrl 一期留空，时间线条目与排行/模块下钻只能做筛选，点不进具体对象（缺陷/文档详情）。待白名单注册表补 TargetUrl 生成规则后接通 |
| 鉴权态端到端验收依赖人工 | 留尾 | AI 自测覆盖：单测（折叠/脱敏/时区）、CDS 容器编译部署、未鉴权端点路由探活；stats 真实数据渲染需管理员登录态，由真人预览验收 |

## 隐私脱敏现状

- 开关默认开启（匿名模式），localStorage 记忆（纯 UI 偏好，符合 no-localstorage.md 例外清单）。
- 脱敏范围：仅成员姓名（姓 + **）。文档/对象标题按业界惯例（GitHub/GitLab/Linear 均明文显示对象名）**不脱敏**——2026-06-12 用户确认「文档名字不需要隐藏部分内容」。头像与模块/动作类型不脱敏。
- 留尾：如需「投屏模式」级别的更强脱敏（隐藏头像、排行只显名次），再加档位。

## 行为洞察 MVP（2026-06-12）已知边界

| 项 | 状态 | 说明 |
|------|------|------|
| 搜索无果信号未接入 | 待解决 | 「搜了又搜没有结果」需要各搜索入口统一埋点（系统无中央搜索抽象），MVP 未覆盖；后续可从 Cmd+K / 各列表搜索框收口 |
| 中途放弃为秒退近似 | 设计取舍 | 真实「漏斗放弃」（打开创建弹窗未提交等）需业务级漏斗定义；MVP 用「5 秒内离开」近似，命名诚实为「秒退放弃」 |
| 改进建议为规则模板 | 部分偿还 | 单条洞察 suggestion 仍为模板；整体「AI 简报」已接 ILlmGateway（insight-brief caller，SSE 流式 + 可发布知识库）。单条级 AI 建议待做 |
| 停留时长不区分「阅读」与「卡住」 | 设计取舍 | 已剔除标签页隐藏时间，但页面内挂机无法区分；长停留洞察文案已提示由产品负责人结合页面性质判断 |
| 路由信号自上线起累积 | 事实声明 | behavior_events 无历史回填；报错/慢端点洞察来自 apirequestlogs（含历史）。UI 已展示采集起点 |
| behavior_events 无索引 | 待 DBA | 按 no-auto-index 规则不自动建索引；数据量上来后需 DBA 手动建 (OccurredAt desc) + (Type, OccurredAt) 索引并更新 guide.platform.mongodb-indexes |

## 涌现第二波留尾（2026-06-12）

- E5 洞察主动推送（admin_notifications + webhook）未做：需要定时 Worker 对比洞察快照（新出现/严重度跃升才推），避免「看页面才知道」。洞察计算已抽成 ComputeInsightsAsync，Worker 可直接复用。
- AI 简报发布后未自动出分享链：知识库分享链需调 document_store_share_links 流程，目前发布后由人工在知识库页开分享。

## 团队动态团队能力

团队能力（网页托管与知识库的角色细分、直接加成员）的分波进展与验证状态。

> 模块: 团队（网页托管 + 知识库）
> 创建: 2026-05-25

团队功能（wave 1）已落地核心 11 项需求。本文件登记交付时主动声明的已知边界与后续可补项，避免下一次 session 无人记得。

### wave 2 进行中：网页托管角色细分（owner/editor/viewer）

2026-05-26 起，网页托管团队共享层把决策 10「成员全员平等」细分为三角色（知识库仍按决策 10 不变）：

- 模型：`TeamMember.WebHostingRole`（nullable，仅网页托管消费）。null = 继承（admin→owner / member→editor），存量成员零降权迁移；显式设 viewer 才只读。
- 策略：`PrdAgent.Core.Security.WebHostingPermission`（纯函数）+ `TeamService.GetMyWebHostingTeamRolesAsync`。`HostedSiteService` 的 Update/Reupload/Delete/BatchDelete/CreateShare 已接角色门控；Get/List 读路径不变（viewer 可读）。
- 能力矩阵：viewer 只读；editor 读+编辑+重传+建分享（**不能删别人创建的站点**）；owner（团队管理员默认映射）全开；站点创建者对自己的站点恒为 owner。

#### 已落地（Phase 1 地基 + Phase 2 角色管理）
- **角色可设**（Phase 2）：`PUT /api/teams/{id}/members/{userId}/web-hosting-role`（仅团队管理员可调，团队创建者恒 owner，role=null 重置继承）。团队管理面板成员行新增「网页托管角色」选择器；网页托管团队视图按 `myWebHostingRole` 隐藏 viewer 的编辑/删除/分享/设公开入口 + 批量操作门控 + 顶部「我的权限」角标。`GET /api/teams/{id}` 返回 `webHostingRoles` 映射，`GET /api/web-pages?scope=team` 返回 `myWebHostingRole`。
- **删除行为变化**：细分前任意成员可删团队内任意站点；现在普通成员(editor)只能删自己创建的，删别人的需 owner（团队管理员或站点创建者）。这部分缓解了下面边界 #1 的「恶意删」风险，但回收站仍未做。

#### 仍未覆盖（wave 2 续作）
- **写路径拒绝返回 404**：viewer/非成员尝试 Update/Delete 时服务返回 null→控制器 404（不泄露存在性）；CreateShare 返回 403。UI 已按角色隐藏入口，404 仅作纵深防御兜底。
- **「分享到团队」批量入口在团队作用域隐藏**：setSiteTeams 后端仅站点创建者可调，团队视图里对非创建者会逐条失败，故只在个人作用域显示该批量按钮。
- **知识库未跟进**：本次只动网页托管，知识库仍按决策 10 全员平等。
- **后端编译**：本地无 dotnet SDK，C# 编译由 CDS 灰度构建验证；前端 `pnpm tsc --noEmit` + `eslint` 改动文件零告警已本地跑通；纯单测 `WebHostingPermissionTests` 走 CI，本地未执行。

#### 1. 团队回收站（软删除，E3）未实现
决策 10「全员可删除」下，团队成员误删/恶意删会直接毁掉别人内容，无回收站兜底。
- 网页托管已部分缓解：删除收敛到 owner / 站点创建者（见上）；知识库仍是全员可删。
- 当前：删除即物理删除（与个人版一致）。
- 建议（紧邻 wave 2 第一项）：给 HostedSite / DocumentEntry 加 `IsDeleted`/`DeletedAt`，团队内容删除走软删 + 30 天回收站视图 + restore 端点。改动面：两模块所有 delete 路径 + list 过滤 `IsDeleted==false` + 回收站 UI。

#### 2. 知识库部分次要端点仍 owner-only（未放宽到团队成员）
为控制本次改动面与风险，以下 DocumentStoreController 端点保持「仅 owner」，团队成员暂不可操作共享库的这些动作：
- 订阅管理：`AddSubscription` / `AddGitHubSubscription` / `TriggerSync` / `ListSyncLogs` / `UpdateSubscription`
- 分享链接：`CreateShareLink` / `ListShareLinks` / `RevokeShareLink`（对外分享属所有权动作，与网页托管 SetVisibility 保持 owner-only 一致）
- 划词评论：`CreateInlineComment` / `DeleteInlineComment`（store.OwnerId 校验未放宽）
- AI 加工：`GenerateSubtitle` / `Reprocess` / `GetLatestAgentRun`
- 浏览分析：`ListStoreViewEvents`

已放宽到 owner-or-member 的核心协作端点（决策 10）：列表/详情读、UpdateStore/DeleteStore/SetPrimaryEntry、AddEntry/CreateFolder/UploadFile、UpdateEntry/DeleteEntry/MoveEntry/UpdateEntryContent/ReplaceEntryFile/RebuildContentIndex/SetFolderPrimaryChild/TogglePinnedEntry。

后续若要全面协作，按同样的 `CanWriteStore` 模式逐个放宽，并补对应活动日志埋点。

#### 3. 公共团队（Visibility=public）仅留字段，行为未实现
`Team.Visibility` 已支持 private/public，但「public = 团队内容对本应用所有登录用户只读可见」的查询分支未接。当前所有团队按 private 处理。wave 2 再接 public 只读视图。

#### 4. 邀请「链接」仅给邀请码，无落地路由
邀请走邀请码（在「管理团队」面板内兑换），未实现 `/join-team/{code}` 落地页路由（刻意走 modal 避开 navCoverage 新路由）。若产品要可点击邀请链接，再加路由并登记 ALLOW_LIST。

#### 5. 成员归属头像兜底（users/by-ids）未在所有路径接入
- 网页托管团队列表：后端 `owners` map 已带创建者昵称/头像 → 已覆盖。
- 知识库团队列表：后端 `ownerName`/`ownerAvatarFileName` 已带 → 已覆盖。
- 知识库「条目级」创建者头像（DocumentEntry.CreatedByName/Avatar）：新条目已写快照；**旧条目**缺快照时前端尚未调 `/api/teams/user-cards` 兜底（条目树 UI 未改）。后续接 DocBrowser 时补。

### 验证状态（交付时）
- 前端：`pnpm tsc` 通过 / 新增文件 `eslint` 零告警 / `navCoverage` 测试通过。
- 后端：本地无 dotnet SDK，C# 编译由 CDS 灰度环境验证（push 触发 webhook 自动构建）。push 后须确认 CDS 绿灯 + 预览域名端到端走通团队建/邀请/分享/编辑/活动日志，再视为完成。

---

### wave 2.5：直接添加成员 + 退出团队 + 解散移入文件夹（2026-05-28，PR #682）

用户明确反馈「邀请就是直接同意就行，链接邀请不合适，应该用公共用户组件让用户多选点击邀请，然后自动同意进来；还有退出和解散，退出就是成员移除，解散就是托管会默认移动到 owner 的主分支的同名文件夹团队文件夹下」。本次落地，完整覆盖。

#### 已落地
- **多选直接添加**：三处入口（`TeamScopeBar` banner / `SpaceBar.TeamSpaceHeader` / `TeamManagerPanel`「添加成员」tab）全部走「搜索 + 多选 + 确认添加」，调用 `POST /api/teams/{id}/members` 批量入组，自动同意无需对方确认。**完全移除邀请链接 UI**（旧 `inviteLink` / 复制按钮 / 重置链接全删）。
- **退出团队**：`TeamManagerPanel` 右上角新增「退出」按钮，仅对非 owner 成员可见（owner 看到「解散团队」红字按钮）。逻辑：`DELETE /api/teams/{id}/members/{self}`；owner 自退被后端 `RemoveMember` 的 `if (memberUserId == team.OwnerUserId) return BadRequest("不能移除团队创建者")` 拦截。
- **解散文件夹归属**：`DELETE /api/teams/{id}` 解散逻辑改造为按 `OwnerUserId` 分支：owner 的托管站点 `HostedSite.Folder = "{团队名} 团队解散文件夹"`（同时拉掉 `SharedTeamIds`），其他成员站点仅拉掉 `SharedTeamIds` 回各自个人空间。前端 confirm 文案明确告知文件夹归属。
- **TeamManagerPanel 支持 initialTab/initialTeamId props**：外部入口（如 SpaceBar 邀请按钮）可指定打开后直接落「添加成员」tab。

#### 已知边界
- **直接添加成员不通知对方**：无站内消息推送，对方下次刷新左侧 SpaceBar 才看到新团队 chip。未来若加站内通知系统补「你被添加进 {team}」消息。
- **解散文件夹仅对 owner 站点生效**：其他成员的站点解散时仅移除团队引用，回到各自个人空间，不放进任何文件夹（设计如此——非 owner 没有"我的解散文件夹"概念）。文档化避免未来产生疑问。
- **owner 不能"退出"自己的团队**：API 层拦截"创建者退出"，前端隐藏「退出」按钮。如需转让所有权，需先在 wave 3 加 `TransferOwnership` 端点。
- **解散无回收站**：与 wave 1 边界 #1 同源（团队回收站未实现），解散后 owner 文件夹里的站点是真实站点（可恢复回团队），但活动日志/分享链记录会全部删除。

#### 验证证据
完整验收报告归档：`https://dreamy-brahmagupta-mumfb-claude-prd-agent.miduo.org/s/lib/QLs14tp7PtH5`
- 10/10 用例 PASS（创建/多选添加/退出拦截/非 owner 退出/解散文件夹 confirm 文案 等）
- 截图存放 `/tmp/acc_team_shots/`，driver 脚本 `/tmp/team-driver.mjs`

## 行为洞察与 VOC 旧版边界

行为洞察与旧版用户之声的待建造项、已定方向与已落地部分，避免跨会话丢失。

> 记录已知边界、待建造项、用户已确认但尚未落地的方向，避免跨 session 丢失。

### 待建造：顶部 ribbon 换成「我来时的路」流式动画（用户已确认方向，2026-06-20）

把顶部点不动的死步骤条（`ExperienceRibbon.tsx` 当前为静态六阶段）换成一段会演的「来路」动画。已出 demo（`behavior-insights-journey-mockup.html`）确认方向，用户追加硬约束：

- **播放时机**：切换时间范围（以及首次进入 / 重新聚合）时触发播放；播完落定为数据态。
- **真流式分析架构（关键）**：动画必须由**真实的流式分析**驱动，数据准确，不能是假特效。需要后端 SSE 端点（如 `GET /api/team-activity/insights/replay-stream?from=`），流式吐出真实管道进度与真实计数：监测(已采 N 条信号) → 预警(检出 M 处突增，附真实 burstPct) → AI 根因(待诊断 K 处) → 转缺陷/需求(已流转 X) → 修复追踪(在修 Y) → 复测回落(回落 Z%)。前端把动画进度同步到流事件，每阶段亮起时显示该阶段真实数字。
- **体量小巧**：不能太大，占 ribbon 一条带状区域即可，不喧宾夺主（artifact-is-experience：产物是主，动画是叙事配角）。
- **平滑落定**：播放完成后平滑过渡到「数据态 ribbon」（六阶段真实计数 + 可点入对应清单），不能突兀；主体页面结构保持不变（Hero/榜单/抽屉都不动）。
- **动态感**：要"真在干活"的感觉（粒子/光点沿路 + 计数跳动 + 突增曲线尖起再回落），但服务于真实数据，不为炫技。
- **降级**：流式不可用时退化为「直接显示数据态 ribbon」，不卡白屏（遵守禁止空白等待 + server-authority：CancellationToken.None + 10s 心跳）。
- **排期**：在 Wave B（多视角切换）之后做，避免与 ribbon/InsightsPanel 文件冲突；可与「时间选择新控件」合并为一个建造波次。

### 已定方向：时间选择控件 = 方案1 + 方案2 结合（2026-06-20 用户拍板）

时光机 demo（全屏）被否（太 low + 全屏不宜查看）。出了 `behavior-insights-timepicker-options.html` 三方案对比，用户拍板：**方案1（活动密度刷选条）+ 方案2（预设胶囊 + 悬浮微预览）结合**，并特别喜欢方案2「时间预设 + 鼠标悬浮微预览」的动效。

落地形态（Wave D 实现，替换页头当前 全部/今天/本周/本月 chips）：
- **主体 = 预设胶囊 + 悬浮微预览（方案2 动效，用户最爱的点）**：保留 全部/今天/本周/本月 胶囊，每个 hover/focus 弹出小巧锚定 popover，显示该范围真实「信号数 / 痛点数 + mini sparkline」微预览（数据要准，走真实各时间窗聚合）。
- **结合 = 活动密度刷选条（方案1）做自定义范围**：胶囊末尾「自定义范围」展开方案1 的活动密度刷选条（背景画真实按天活动量/痛点密度柱，拖两把手刷选窗口，拖动结束 debounce 再请求），让用户先看波形再框选。
- 全程紧凑锚定、非全屏；微预览/密度柱数据由后端真实聚合（可复用/扩展 experience-trend 的时间桶端点提供各预设窗口的 信号/痛点 摘要 + 密度序列）。
- 与「我来时的路」流式动画合并到同一个建造波次（Wave D）。

### 已落地（参考，勿重复）

- 体验全景热力图（treemap，全域/痛点双模式 + 写字入场 + 点睛 + 突增彗星 + morph + 全屏放大）
- 点痛点块下钻抽屉（错误码分布 + curl 样本 + AI 流式根因诊断）
- 闭环 ribbon（静态六阶段，待上面的流式动画替换）
- 痛点流转产品需求池（SourceSystem=voc-insight）+ 复测回落追踪（reboundPct）
- 布局 Hero 化 + tab/时间范围上移页头 + 切换 shimmer 过渡 + insights 视图不白拉 feed
- 多视角切换（趋势爆点/痛点雷达/站点地图/声道看板）—— Wave B 进行中
