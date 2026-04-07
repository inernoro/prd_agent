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

## 使用方式

### Agent 自动触发

当 Agent 需要验证页面效果（如部署后检查 UI、操作 Agent 功能）时，Agent 自行调用 Bridge API。用户无需做任何配置，只需**在浏览器中打开预览页面**即可。

### 用户手动触发

在 Claude Code 中输入 `/bridge` 或说"操作页面"、"帮我操作"，Agent 会进入 Bridge 操作模式。

### 完整操作流程

```
1. 用户打开预览页：https://{branch-id}.miduo.org/
2. Agent 调用 start-session → Widget 激活（左下角出现蓝色指示点）
3. Agent 发送操作指令 → 用户看到鼠标移动 + 目标高亮 + 操作面板
4. Agent 调用 end-session → Widget 显示"✅ AI 操作完成"后恢复静默
```

### 用户需要配合的动作

| 场景 | 用户操作 |
|------|---------|
| 首次使用 | 在浏览器中打开预览页面 |
| 收到导航请求 | 点击 Widget 弹出的"打开页面"按钮 |
| 需要登录 | 无需操作——Agent 会自动输入账号密码并点击登录 |
| 操作结束 | 无需操作——Agent 会自动 end-session |

## 已知局限

| # | 局限 | 表现 | 规避方式 |
|---|------|------|---------|
| 1 | **`navigate` 会丢 session** | 全页面刷新清空 sessionStorage | 登录后只用 `spa-navigate` 或 `click` |
| 2 | **首页 Agent 卡片文字为空** | DOM 提取拿不到图片/CSS 渲染的内容 | 用 `evaluate` 搜索 textContent 并点击 |
| 3 | **操作不触发 `:hover` 效果** | 合成事件不触发 CSS 伪类 | 不影响功能，仅视觉差异 |
| 4 | **命令最大延迟 ~500ms** | 轮询间隔决定（非即时） | 对自动化场景可接受 |
| 5 | **需要用户打开页面** | Agent 不能自行打开浏览器 | Agent 发 navigate-request，用户点击打开 |
| 6 | **页面刷新后需重新激活** | navigate 或手动刷新会销毁 Widget | Agent 检测到断连后重新 start-session |
| 7 | **鼠标动画是渲染层叠加** | 非真实系统光标（与 Manus/page-agent 相同） | 不影响操作，仅视觉表演 |
| 8 | **模板字符串中不能用正则** | `\/` 在 TS 模板中转义失效 | Widget 代码中用字符串方法替代正则 |

## 相关文档

- `doc/design.page-agent-bridge.md` — 技术设计（架构图 + 数据流 + 超时参数）
- `.claude/rules/bridge-ops.md` — 操作规范（按需加载，编辑 `cds/src/**/*.ts` 时触发）
