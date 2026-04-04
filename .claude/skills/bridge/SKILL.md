---
name: bridge
description: "Page Agent Bridge：通过 CDS 预览页面远程操作用户浏览器，实现 DOM 读取、鼠标轨迹点击、表单输入、SPA 导航等操作。"
triggers:
  - "/bridge"
  - "操作页面"
  - "打开预览"
  - "页面自动化"
  - "bridge test"
  - "帮我操作"
---

# Page Agent Bridge — 远程操作预览页面

通过 CDS Widget 注入的 Bridge Client，Agent 可以读取用户浏览器中的真实页面 DOM、
执行点击/输入操作（带鼠标轨迹动画），实现端到端的页面验证和自动化操作。

## 触发词

- `/bridge` / "操作页面" / "打开预览" / "帮我操作"

## 前置条件

1. 当前分支已部署到 CDS（用 `/cds-deploy`）
2. 用户已在浏览器中打开预览页面
3. 环境变量 `CDS_HOST` 和 `AI_ACCESS_KEY` 已配置

## 操作流程

### Phase 1: 确认连接

```bash
CDS="https://$CDS_HOST"
BRANCH_ID=$(git branch --show-current | tr '/' '-' | tr '[:upper:]' '[:lower:]')

# 检查是否有活跃连接
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" "$CDS/api/bridge/connections"
```

如果无连接，发导航请求让用户打开页面：

```bash
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS/api/bridge/navigate-request" \
  -d "{\"branchId\":\"$BRANCH_ID\",\"url\":\"/\",\"reason\":\"需要操作预览页面\"}"
```

### Phase 2: 读取页面

```bash
# 读取 DOM 和页面状态
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -X POST "$CDS/api/bridge/command/$BRANCH_ID" \
  -d '{"action":"snapshot","params":{},"description":"读取当前页面"}'
```

返回值包含：
- `state.url` — 当前 URL
- `state.title` — 页面标题
- `state.domTree` — 简化 DOM（交互元素带 `[index]` 编号）
- `state.consoleErrors` — JS 错误
- `state.networkErrors` — 网络错误

### Phase 3: 执行操作

**所有命令必须带 `description` 字段！** 用户在操作面板中看到的就是 description。

```bash
# 点击（带鼠标轨迹动画 + 目标高亮）
curl -sf ... -d '{"action":"click","params":{"index":6},"description":"点击「登录」按钮"}'

# 输入文本（带目标高亮）
curl -sf ... -d '{"action":"type","params":{"index":0,"text":"hello","clear":true},"description":"在搜索框输入 hello"}'

# SPA 页面跳转（不丢 session！）
curl -sf ... -d '{"action":"spa-navigate","params":{"url":"/literary"},"description":"跳转到文学创作"}'

# 滚动
curl -sf ... -d '{"action":"scroll","params":{"direction":"down","pixels":500},"description":"向下滚动查看更多"}'
```

## 关键规则

### ⚠ 登录后禁止用 `navigate`

`navigate` 全页面刷新会清空 `sessionStorage` token。登录后所有跳转用 `spa-navigate`。

### ⚠ 操作前先 snapshot

元素索引 `[index]` 在页面变化后会失效。每次页面状态变化后重新 snapshot。

### 标准登录流程

```
1. {"action":"navigate","params":{"url":"/login"},"description":"打开登录页"}
2. {"action":"type","params":{"index":0,"text":"用户名","clear":true},"description":"输入用户名"}
3. {"action":"type","params":{"index":1,"text":"密码","clear":true},"description":"输入密码"}
4. {"action":"click","params":{"index":2},"description":"点击登录按钮"}
5. 等待 5 秒
6. {"action":"snapshot","params":{},"description":"确认登录成功"}
7. 此后只用 spa-navigate + click
```

## 指令参考

| action | 参数 | 说明 | 鼠标动画 |
|--------|------|------|---------|
| `snapshot` | `{}` | 读取页面 | 否 |
| `click` | `{index}` | 点击 | ✓ 轨迹+高亮 |
| `type` | `{index, text, clear?}` | 输入 | ✓ 轨迹+高亮 |
| `scroll` | `{direction, pixels?}` | 滚动 | 否 |
| `spa-navigate` | `{url}` | SPA 跳转 | 否 |
| `navigate` | `{url}` | 全刷新跳转 | 否 |
| `evaluate` | `{script}` | 执行 JS | 否 |

## 视觉反馈

用户在浏览器中会看到：
1. **鼠标轨迹**：蓝色 SVG 光标从当前位置平滑移动到目标元素
2. **目标高亮**：蓝色脉冲光环框选目标元素
3. **操作面板**：Badge 上方弹出步骤列表（◎执行中 → ✓完成 / ✗失败）
4. **导航请求**：蓝色发光面板提示用户打开页面

## 相关文档

- `doc/design.page-agent-bridge.md` — 技术设计
- `.claude/rules/bridge-ops.md` — 操作规范（按需加载）
