| feat | prd-admin | GAP-10 Phase 1：将画布状态色（running/completed/failed/paused）、边框色、连线色、动画时长抽成 CSS 自定义属性，追加到 tokens.css；workflow-canvas.css 消费新变量，不再硬编码 rgba 颜色值 |
| feat | cds | P5 Phase 1：新增 CdsWorkspaceMember / CdsWorkspaceInvite 域类型；AuthStore 接口扩展成员/邀请方法；MemoryAuthStore + MongoAuthStore 实现；新增 WorkspaceService；新增 /api/workspaces 路由（CRUD + 成员管理 + 邀请流程）；Project 类型新增 workspaceId 字段；前端工作区 pill 从 /api/workspaces 动态加载 |
| fix | cds | IAuthMongoHandle 新增 membersCollection / invitesCollection；RealAuthMongoHandle 实现对应集合 |
