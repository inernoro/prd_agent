# 导航注册规则（新功能/新 Agent 必须声明去哪里）

> **背景**：用户反馈新建智能体或新增功能后，只给了路由甚至只给了名字，不知道从哪进去——首页？左侧导航？百宝箱？必须根除这类"可执行但找不到"的体验缺陷。

## 硬规则

### 规则 1：任何新 Agent 默认注册到百宝箱

创建新智能体/Agent 时，**默认且必须**在百宝箱（AI Toolbox）中注册可见入口。不允许只加路由不加入口。

**默认注册位置**：`prd-admin/src/stores/toolboxStore.ts` 的 `BUILTIN_TOOLS` 数组

**最小字段**：
```typescript
{
  id: 'builtin-{agent-key}',
  name: '{中文名}',
  description: '{一句话说明}',
  icon: '{Lucide 图标名}',
  category: 'builtin',
  type: 'builtin',
  agentKey: '{agent-key}',
  routePath: '/{agent-route}',   // 定制版专属页面才填
  tags: ['标签1', '标签2'],
  usageCount: 0,
  createdAt: new Date().toISOString(),
}
```

若未指定 `routePath`，表示走百宝箱内的统一对话界面（普通版）。

### 规则 2：左侧导航、首页快捷入口为可选升级

下列两处是**可选**位置，只有用户明确要求"放到左侧导航"/"放到首页"时才追加，不得私自注册：

| 位置 | 注册文件 | 触发条件 |
|------|---------|---------|
| 左侧导航 | `prd-api/src/PrdAgent.Core/Security/AdminMenuCatalog.cs` + `prd-admin/src/lib/authzMenuMapping.ts` | 用户明确说"加到左侧" / 高频使用的核心模块 |
| 首页快捷 | `prd-admin/src/pages/home/LandingPage.tsx` + `prd-admin/src/pages/home/MobileHomePage.tsx` 的 `QUICK_AGENTS` | 用户明确说"放首页" / 面向全体用户的入口 |

**单一来源**：同一个 Agent 同时注册到多处时，左侧导航条目必须与百宝箱条目指向同一 `routePath`，禁止出现"首页能点开但百宝箱里没有"的断层。

### 规则 3：交付时必须声明"在哪里能看到"

完成开发后，无论是否触发 `/handoff`，回复用户的消息中**必须**包含一句明确的位置描述，格式固定为：

```
【位置】百宝箱（AI 百宝箱 → 搜索 "XXX"）或 左侧导航"XX"菜单 或 首页快捷入口
【路径】从登录后首页开始：1) 点击 → 2) 点击 → 3) 到达
```

禁止以下表达方式：
- ❌ "已完成，访问 `/new-agent` 即可"（只给路由）
- ❌ "功能已上线"（连路由都没）
- ❌ "在管理后台可以看到"（位置模糊）
- ✅ "已完成。【位置】百宝箱 → 搜索"评审员"即可打开；或点击左侧【AI 百宝箱】菜单 → 内置工具区"

## 审计清单（新增或修改 Agent 入口时）

- [ ] 已在 `toolboxStore.ts` 的 `BUILTIN_TOOLS` 中注册条目（默认必做）
- [ ] 如果用户要求加左侧导航：`AdminMenuCatalog.cs` + `authzMenuMapping.ts` 已同步
- [ ] 如果用户要求加首页快捷：`LandingPage.tsx` / `MobileHomePage.tsx` 的 `QUICK_AGENTS` 已同步
- [ ] 同一 `routePath` 在所有注册点保持一致，无分叉
- [ ] 权限已通过 `add-agent-permission` 技能注册（`RequirePermission` 与 Controller 的 `[AdminController]` 对齐）
- [ ] 交付消息包含【位置】+【路径】两行

## 反面案例

| 错误做法 | 正确做法 |
|---------|---------|
| "新建了 ReviewAgent，路由 `/review-agent`" | "新建了产品评审员，已注册到百宝箱（内置工具区）+ 左侧导航可选。【位置】侧边栏【AI 百宝箱】→ 搜索 '评审'" |
| 只加了 `App.tsx` 路由，没加百宝箱条目 | 必须同步加 `BUILTIN_TOOLS` 条目 |
| 硬编码到左侧导航但不告诉用户去哪找 | 默认放百宝箱，明确说出菜单路径 |
| 放到首页但没同步百宝箱 | 百宝箱是最低配置，首页是升级 |

## 与相关规则的关系

- **`guided-exploration.md`**：确保进入页面后知道怎么用；本规则确保**找到页面**
- **`add-agent-permission.md` 技能**：权限注册；本规则补充导航入口注册
- **`task-handoff-checklist` 技能**：交接时第一节"导航与入口变更"引用本规则强制校验
