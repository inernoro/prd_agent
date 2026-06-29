# 视觉验收技能跨仓库使用教程

> **类型**：guide | **适用角色**：开发者 / AI Agent 使用者 | **最后更新**：2026-06-10
> **技能**：`create-visual-test-to-kb` | **当前教程基准版本**：`1.0.0`

---

## 1. 标准路径

教别人使用视觉验收技能时，不要给个人 `accesskey`，也不要把密钥写进仓库。

标准路径是：

1. 使用者用自己的账号登录 MAP / PrdAgent。
2. 在「海鲜市场 → 接入 AI」创建自己的 `sk-ak-*` AgentApiKey。
3. 勾选 `marketplace.skills:read`；需要上传技能时再勾选 `marketplace.skills:write`。
4. 安装官方 `findmapskills` 技能。
5. 用 `findmapskills` 从海鲜市场搜索、下载、更新 `create-visual-test-to-kb`。
6. 在目标仓库调整 `acceptance.config.json`，运行 `/验收`。

这样换仓库、换用户、换机器都成立，权限归属也清楚。

## 2. 前置条件

| 项目 | 必须满足 | 不满足时 |
|------|----------|----------|
| 个人用户权限 | 使用者能登录平台并打开 `/marketplace` | 先给账号开通访问权限，不借用别人的 Key |
| 海鲜市场技能接口 | 能创建 `sk-ak-*`，并能调用 `/api/open/marketplace/skills` | 先修开放接口和 scope 白名单 |
| `findmapskills` | 海鲜市场可下载官方 `findmapskills`，当前后端权威版本 `1.1.0` | 先访问 `/api/official-skills/findmapskills/download` 验证 |
| 视觉验收技能 | 海鲜市场能搜到 `create-visual-test-to-kb`，版本字段可见 | 若搜不到，先发布/打包官方技能 |
| 目标仓库运行条件 | Node、Python、Playwright 可用 | 先装运行依赖，或把报告模式降级为 local |

## 3. 生成个人授权

让使用者打开：

```text
https://你的平台域名/marketplace
```

操作路径：

1. 点击右上角「接入 AI」。
2. 进入「新建 Key」。
3. Key 名称写清楚用途，例如 `视觉验收 · 张三 · MacBook`。
4. 权限范围至少勾选 `marketplace.skills:read`。
5. 如果需要把改好的技能重新发到海鲜市场，再勾选 `marketplace.skills:write`。
6. TTL 建议选 1 年。
7. 创建后只显示一次明文，复制到自己的 AI 工作环境。

推荐写入用户主目录的 shell 配置，不写项目文件：

```bash
echo 'export PRD_AGENT_BASE="https://你的平台域名"' >> ~/.zshrc
echo 'export PRD_AGENT_API_KEY="sk-ak-这里替换成自己的key"' >> ~/.zshrc
source ~/.zshrc
```

安全要求：

- 禁止把 `PRD_AGENT_API_KEY` 写进仓库、`.env`、README、教程截图或聊天记录。
- 每个人用自己的 Key。离职、换机器、泄露时只撤销这一个 Key。
- 发现响应头 `X-AgentApiKey-ExpiringSoon` 时续期；401 且不是网络问题时重建或检查是否被撤销。

## 4. 安装海鲜市场操作技能

先装官方 `findmapskills`，它负责搜索、下载、上传、订阅海鲜市场技能。

```bash
curl -L "$PRD_AGENT_BASE/api/official-skills/findmapskills/download" -o /tmp/findmapskills.zip \
  && mkdir -p ~/.claude/skills \
  && unzip -o /tmp/findmapskills.zip -d ~/.claude/skills/ \
  && rm /tmp/findmapskills.zip
```

安装后检查版本：

```bash
grep -n "版本" ~/.claude/skills/findmapskills/SKILL.md | head
```

当前后端权威版本在 `OfficialSkillTemplates.FindMapSkillsVersion`，本教程写作时是 `1.1.0`。

## 5. 下载视觉验收技能

用 Open API 搜索：

```bash
AUTH=(-H "Authorization: Bearer $PRD_AGENT_API_KEY" -H "Accept: application/json")

curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?keyword=create-visual-test-to-kb&sort=hot&limit=20" "${AUTH[@]}" \
  | jq '.data.items[] | {id,title,version,description,tags}'
```

找到目标条目后下载：

```bash
SKILL_ID="替换为搜索结果里的 id"
RESP=$(curl -sS -X POST "$PRD_AGENT_BASE/api/open/marketplace/skills/$SKILL_ID/fork" "${AUTH[@]}" \
  -H "Content-Type: application/json" -d '{}')
URL=$(echo "$RESP" | jq -r '.data.downloadUrl')
NAME=$(echo "$RESP" | jq -r '.data.fileName // "create-visual-test-to-kb.zip"')
curl -sSL -o "/tmp/$NAME" "$URL"
unzip -o "/tmp/$NAME" -d ~/.claude/skills/
```

检查本地版本：

```bash
grep -n "^version:" ~/.claude/skills/create-visual-test-to-kb/SKILL.md
```

本教程基准版本是 `1.0.0`。

## 6. 在别的仓库接入

进入目标仓库后，把技能目录作为外部能力使用，不要把整套技能复制进业务代码。需要项目差异时只改配置。

最小配置点在：

```text
~/.claude/skills/create-visual-test-to-kb/acceptance.config.json
```

重点确认：

| 配置 | 作用 | 建议 |
|------|------|------|
| 预览地址 | 浏览器从哪里开始验收 | 有 CDS 就走 preview 命令；没有就填固定预览 URL |
| 登录选择器 | 无头浏览器如何登录 | 每个系统按真实登录页改 |
| 登录环境变量 | 用户名/密码从哪里取 | 用 `MAP_AI_USER`、`MAP_ACCEPT_PASS` 等 env，不写入文件 |
| 报告模式 | 归档到知识库还是本地文件 | 没有文档空间时先用 `report.mode=local` |
| 报告库名 | doc-store 模式写到哪里 | 默认可用“验收报告”，团队可单独建库 |

目标仓库没有知识库权限时，先跑 local 模式：

```bash
export MAP_AI_USER="你的登录账号"
export MAP_ACCEPT_PASS="你的登录密码"
export PWPATH="$(npm root -g)/playwright"

npm i -g playwright
npx playwright install chromium
```

然后让 AI 执行：

```text
/验收 这次要验收的功能：……
```

执行时必须遵守技能规则：模拟真人点击导航进入、截图有框选重点、读图核对、报告有 verdict、归档后能打开再交付。

## 7. 更新视觉验收技能

使用者更新时先查远端：

```bash
curl -sS "$PRD_AGENT_BASE/api/open/marketplace/skills?keyword=create-visual-test-to-kb&sort=hot&limit=20" "${AUTH[@]}" \
  | jq '.data.items[] | {id,title,version,updatedAt}'
```

再对比本地：

```bash
grep -n "^version:" ~/.claude/skills/create-visual-test-to-kb/SKILL.md
```

版本不同就重新 fork 并覆盖解压。

维护者发布新版时必须：

1. 修改 `.claude/skills/create-visual-test-to-kb/SKILL.md`。
2. 按 SemVer 更新 frontmatter `version:`。
3. 若作为官方技能下发，运行 `node scripts/bundle-official-skills.mjs`。
4. 部署后在海鲜市场搜索 `create-visual-test-to-kb`，确认卡片和 Open API 都返回新版本。

## 8. 如果系统当前不满足

### A. 仍依赖个人 accesskey

问题：不可交接、不可撤销单人权限、容易泄露。

改进：

- 教程、弹窗、脚本全部改用 `PRD_AGENT_API_KEY=sk-ak-*`。
- 给视觉验收归档补最小 scope，例如 `document-store:write`；归档脚本优先读 scoped key，旧 `AI_ACCESS_KEY` 只作为兼容兜底。
- 在文档和示例里删除任何真实 Key。

### B. 海鲜市场搜不到视觉验收技能

问题：别人无法从市场安装，只能靠私下发 zip。

改进：

- 把 `create-visual-test-to-kb` 纳入官方技能目录白名单。
- 确认 zip 内包含 `SKILL.md`、`reference/`、`templates/`、`scripts/`、`acceptance.config.json`。
- Open API 搜索结果必须返回 `id/title/version/description/tags`。

### C. 没有版本号

问题：别人不知道自己装的是不是最新。

改进：

- 每个可发布技能的 `SKILL.md` frontmatter 必须有 `version:`。
- 上传接口优先读取 frontmatter `version`。
- 官方虚拟技能 DTO 必须显式返回 `version` 字段，不只把版本写进描述。
- 更新教程只允许对比结构化 `version`，不要靠人工读卡片文案。

### D. 更新流程靠口头通知

问题：用户装过一次后不会主动更新。

改进：

- `findmapskills` 保留“每月检查版本”命令。
- 海鲜市场列表返回 `updatedAt` 和 `version`。
- 后续可在个人空间的“我收藏的技能”里增加“有新版本”提示。

### E. 目标仓库没有文档空间

问题：验收报告不能归档成分享链。

改进：

- `report.mode=local` 必须是可用降级路径，产出本地 Markdown + 截图。
- 文档空间可用后再切 doc-store 模式。
- 不允许为了归档成功而借用管理员超级 Key。

## 9. 教学话术模板

```text
这套视觉验收不是用我的 accesskey 跑。你先登录平台，用自己的账号在「海鲜市场 → 接入 AI」创建 `sk-ak-*` Key，至少勾选 `marketplace.skills:read`。

然后安装官方 `findmapskills`，用它从海鲜市场下载 `create-visual-test-to-kb`。安装后检查 `SKILL.md` 里的 `version:`，当前教程基准是 1.0.0。

到你的仓库里只改 `acceptance.config.json`：预览地址、登录选择器、登录环境变量、报告模式。没有知识库权限就先用 local 模式，跑通以后再接 doc-store 归档。

以后更新也从海鲜市场重新 fork，不要私下复制旧 zip。
```
