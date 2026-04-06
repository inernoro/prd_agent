# RBAC 权限系统设计

> **状态**：已实现

## 1. 管理摘要

PRD Agent 管理后台采用 RBAC-lite 权限模型，通过「系统角色 + 用户级覆写」两层机制控制 40+ 个权限点。管理员为用户分配一个系统角色（如管理员、运营、只读），角色自带一组权限；在此基础上可对个别用户追加或剥夺特定权限。整套机制在请求进入 Controller 之前由中间件自动拦截，前端通过权限指纹实现免轮询的缓存失效，菜单目录根据权限动态生成。

---

## 2. 产品定位

### 解决的问题

多角色团队共用一个管理后台，不同岗位需要看到不同功能：管理员需要全部权限，运营人员需要模型管理和数据操作但不需要权限管理，体验者只需要使用各类 Agent 而无需接触后台配置。

### 不做什么

- **不做**行级数据权限（如"只能看自己创建的群组"）——当前通过业务逻辑处理
- **不做**多租户隔离——系统为单租户架构
- **不做**审批流——权限分配即时生效，无需审批

### 与 UserRole 的关系

`SystemRole`（权限角色）与 `UserRole`（PM/DEV/QA/ADMIN 的业务语义角色）完全解耦。一个 QA 身份的用户可以拥有管理员级别的后台权限，反之亦然。

---

## 3. 用户场景

### 场景一：新员工入职

运营负责人打开用户权限页面，为新员工选择「运营/运维」角色。新员工立即获得模型管理、数据操作、Agent 使用等权限，但无法操作权限管理和系统设置等敏感功能。

### 场景二：临时授权

某位只读用户需要临时使用工作流引擎。管理员在其权限详情中将 `workflow-agent.use` 加入「额外放行」列表，无需更换角色即可精确开放单项权限。任务结束后移除即可。

### 场景三：权限收回

某位运营人员不再负责开放平台管理。管理员将 `open-platform.manage` 加入其「显式禁止」列表。即使其角色仍包含该权限，实际生效权限中已被剔除。

### 场景四：新版本部署后菜单自动更新

后端新增了一个 Agent 模块并注册了新的权限点。部署后，前端通过响应头 `X-Perm-Fingerprint` 检测到指纹变化，自动刷新权限和菜单缓存，用户无需手动清缓存。

### 场景五：Root 破窗访问

系统出现紧急问题，需要绕过所有权限限制。通过 root 账户登录，自动获得全部权限点（包含 `super`），可访问任何功能。

---

## 4. 核心能力

### 4.1 权限点目录（Permission Catalog）

权限点是系统的最小授权单位，以 `{模块}.{动作}` 格式命名。权限目录在代码中静态定义，是前后端和角色系统共同遵守的契约。

当前系统包含 **40+ 个权限点**，覆盖以下类别：

| 类别 | 权限点示例 | 说明 |
|------|-----------|------|
| 基础准入 | `access` | 进入管理后台的前提条件 |
| Agent 使用 | `prd-agent.use`、`visual-agent.use` 等 | 各 Agent 的使用权限 |
| Agent 管理 | `defect-agent.manage`、`workflow-agent.manage` | Agent 的高级管理权限 |
| 资源读写 | `users.read` / `users.write`、`mds.read` / `mds.write` | 按读/写分离的管理权限 |
| 专项管理 | `open-platform.manage`、`automations.manage` | 独立模块的管理权限 |
| 超级权限 | `super` | 兜底放行，仅限 root/超级管理员 |

**设计约束**：`access` 是所有权限的前提——即使用户拥有某个具体权限点，若不具备 `access`，中间件仍会拒绝请求（root 和 `super` 持有者除外）。

### 4.2 系统角色（System Role）

系统角色是一组权限点的集合，分为内置角色和自定义角色。

**内置角色**（代码定义，不可删除）：

| Key | 名称 | 定位 |
|-----|------|------|
| `admin` | 管理员 | 拥有全部权限点 |
| `operator` | 运营/运维 | Agent 使用 + 模型/数据/资产管理，无权限管理 |
| `viewer` | 只读 | Agent 使用 + 只读管理权限 |
| `agent_tester` | Agent 体验者 | 仅 Agent 使用权限，无管理功能 |
| `none` | 无权限 | 空权限集合 |

**自定义角色**：管理员可通过 API 创建自定义角色，自由组合权限点。自定义角色存储在 MongoDB `system_roles` 集合中，与内置角色合并后统一使用。内置角色优先——若 key 冲突，忽略自定义角色。

### 4.3 权限计算公式

用户的最终有效权限按以下公式计算：

```
有效权限 = (角色权限 ∪ PermAllow) − PermDeny
```

- **角色权限**：用户所属 SystemRole 的 Permissions 列表
- **PermAllow**：用户级额外放行列表（追加权限）
- **PermDeny**：用户级显式禁止列表（剥夺权限）

角色推断规则：若用户未显式设置 `SystemRoleKey`，则根据 `UserRole` 推断——`ADMIN` 推断为 `admin` 角色，其他推断为 `none`。

### 4.4 Controller 声明式权限绑定

每个管理后台 Controller 通过 `[AdminController]` 属性声明所需权限，无需手动编写鉴权逻辑。

属性参数：
- `appKey`：应用标识，用于菜单分组
- `readPermission`：GET/HEAD/OPTIONS 请求所需权限
- `writePermission`（可选）：POST/PUT/PATCH/DELETE 请求所需权限，默认与 readPermission 相同

应用启动时，`AdminControllerScanner` 反射扫描所有标记了该属性的 Controller，构建「路由前缀 → 权限」映射表。运行时中间件据此自动判断。

### 4.5 权限指纹与前端缓存失效

系统通过 SHA256 指纹机制实现权限变更的自动感知：

1. 后端基于权限目录和所有角色定义计算指纹（取前 12 位 hex）
2. 每个 API 响应通过 `X-Perm-Fingerprint` 头下发
3. 前端比较指纹——若不一致，自动重新拉取权限和菜单

触发指纹变化的场景：新部署增删了权限点、管理员修改了角色的权限配置。

### 4.6 动态菜单目录

前端导航菜单不是静态配置，而是由后端根据用户权限动态生成。`AdminMenuCatalog` 定义了所有菜单项及其所属 appKey，`GetMenusForUser` 方法根据用户权限和 Controller 扫描结果计算可见菜单：

- 基础功能（首页、AI 百宝箱、市场等）：仅需 `access` 权限
- 管理功能：用户拥有该 appKey 下任意 Controller 的读或写权限即可见
- 特殊功能（总裁面板）：需要独立的专项权限

---

## 5. 架构

### 5.1 请求处理流程

```
HTTP 请求
    │
    ▼
PermissionFingerprintMiddleware ── 注入 X-Perm-Fingerprint 响应头
    │
    ▼
AdminPermissionMiddleware
    ├─ 调用 AdminControllerScanner.GetRequiredPermission(path, method)
    ├─ 若返回 null（公开路由或非 Admin Controller）→ 放行
    ├─ 检查用户认证状态 → 未认证返回 401
    ├─ 调用 IAdminPermissionService.GetEffectivePermissionsAsync()
    ├─ 检查 super 或具体权限 → 无权限返回 403
    ├─ 检查 access 基础准入 → 缺失返回 403
    ├─ 将有效权限注入 Claims → 供下游 Controller 的 HasPermission() 使用
    └─ 放行 → Controller
```

### 5.2 核心组件职责

| 组件 | 职责 |
|------|------|
| `AdminPermissionCatalog` | 权限点静态定义（代码即契约） |
| `BuiltInSystemRoles` | 内置角色静态定义 |
| `SystemRoleCacheService` | 合并内置+自定义角色，维护缓存和指纹 |
| `AdminPermissionService` | 权限计算引擎（角色 ∪ allow − deny） |
| `AdminControllerScanner` | 启动时反射扫描，构建路由→权限映射 |
| `AdminPermissionMiddleware` | 请求级权限拦截 |
| `PermissionFingerprintMiddleware` | 响应头注入指纹 |
| `AdminMenuCatalog` | 菜单定义与权限过滤 |

### 5.3 前端权限架构

前端通过 `authStore`（Zustand + sessionStorage）管理权限状态：

- 登录后调用 `/api/authz/me` 获取 `effectivePermissions` 和 `permissionFingerprint`
- 调用 `/api/authz/menu-catalog` 获取当前用户可见的菜单列表
- 每次 API 响应检查 `X-Perm-Fingerprint` 头，指纹变化时自动刷新
- 前端路由守卫和组件可直接读取 `permissions` 数组进行 UI 级控制

---

## 6. 数据

### 6.1 存储模型

| 集合 | 用途 | 关键字段 |
|------|------|----------|
| `system_roles` | 自定义角色 | `Key`, `Name`, `Permissions[]`, `IsBuiltIn` |
| `users` | 用户权限配置 | `SystemRoleKey`, `PermAllow[]`, `PermDeny[]` |

内置角色不存储在数据库中，而是从 `BuiltInSystemRoles` 代码定义加载。`SystemRoleCacheService` 在启动时合并两者。

### 6.2 缓存策略

- **角色缓存**：内存中维护合并后的角色列表和 key→role 字典，角色 CRUD 后立即刷新
- **权限缓存**：每次请求实时计算（查询用户 → 查角色缓存 → 计算有效权限），无额外缓存层
- **指纹缓存**：随角色缓存一起更新，O(1) 读取

---

## 7. 接口

### 7.1 权限查询

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/authz/me` | 当前用户权限快照（含有效权限列表、角色、指纹） | 公开（已认证即可） |
| GET | `/api/authz/catalog` | 权限点完整目录 | 公开（已认证即可） |
| GET | `/api/authz/menu-catalog` | 当前用户可见菜单列表 | 公开（已认证即可） |

### 7.2 角色管理

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/authz/system-roles` | 获取所有角色（内置+自定义） | `authz.manage` |
| POST | `/api/authz/system-roles` | 创建自定义角色 | `authz.manage` |
| PUT | `/api/authz/system-roles/{key}` | 更新自定义角色（内置不可改） | `authz.manage` |
| DELETE | `/api/authz/system-roles/{key}` | 删除自定义角色（内置不可删） | `authz.manage` |

### 7.3 用户权限配置

| 方法 | 路径 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/authz/users/{userId}/authz` | 查看用户权限快照 | `authz.manage` |
| PUT | `/api/authz/users/{userId}/authz` | 修改用户角色/allow/deny | `authz.manage` |

---

## 8. 关联

### 8.1 与其他模块的关系

| 模块 | 关系 |
|------|------|
| 应用身份（App Identity） | Controller 的 `appKey` 同时用于权限分组和菜单归属 |
| LLM Gateway | Agent 权限点控制用户是否能触发 LLM 调用 |
| 配置市场（Marketplace） | 市场浏览需要 `access`，发布需要对应 Agent 的使用权限 |
| 开放平台 | AI 超级访问密钥（AiAccessKey）等同 root，绕过权限检查 |

### 8.2 扩展新权限的标准流程

1. 在 `AdminPermissionCatalog` 新增权限常量和定义
2. 在 `BuiltInSystemRoles` 中为需要该权限的内置角色添加
3. 在 Controller 上标记 `[AdminController]` 属性引用新权限
4. 前端自动通过指纹变化感知新权限，菜单自动适配

此流程无需手动修改前端路由配置或菜单定义——`AdminControllerScanner` 和 `AdminMenuCatalog` 自动处理映射。

---

## 9. 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 权限点只增不减，长期膨胀 | 角色配置页面变得复杂 | 按类别分组展示；定期审计废弃权限 |
| 角色缓存与数据库不一致 | 用户权限判断错误 | 角色 CRUD 后立即刷新缓存；重启时重建 |
| PermDeny 使用不当导致管理员自锁 | 管理员无法操作权限页面 | root 账户不受权限限制，可破窗恢复 |
| 新 Controller 忘记标记 `[AdminController]` | 接口无权限保护 | 未标记的路由不被中间件拦截（默认放行），需通过代码审查保障 |
| 内置角色权限在代码中硬编码 | 修改内置角色权限需要重新部署 | 设计决策：内置角色保持稳定，灵活需求通过自定义角色或用户级覆写满足 |
