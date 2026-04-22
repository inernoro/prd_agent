---
name: create-tour-demo
description: 批量创建「教程小书」的路径式引导演示（DailyTip + 多步 Tour）。用户说"创建 XX 演示" / "做一个 XX 教程" / "/create-tour-demo 缺陷管理" 时触发。支持缺陷管理、Ctrl+B、Ctrl+K 搜索、更新中心周报、知识库发布 5 种内置模板,也支持自然语言描述任意页面路径。输出可直接 POST 到 /api/admin/daily-tips 的 JSON,或生成 curl 脚本让用户一键植入。
---

# 创建教程演示

## 触发

- "创建 XX 演示"、"做一个 XX 教程"、"XX 演示生成"
- "/create-tour-demo"、"/create-demo"
- 「新增一条小贴士教程」
- 「缺陷管理全链路演示」等具体模板名

## 核心职责

给定一个「要演示的功能名」,生成一条完整的 DailyTip 记录:
- `kind = "card"`(显示在右下角抽屉)
- 完整的 **多步 Tour autoAction**(步骤序列),每步指向一个 `data-tour-id`
- 合理的 `actionUrl`(起点页面)、`title`、`body`、`ctaText`
- 可直接 POST 到 `/api/admin/daily-tips` 入库,或生成 curl 用户自己贴

## 使用方法

### A. 内置模板(直接用)

用户说"创建缺陷管理演示"、"创建 Ctrl+K 演示"等,匹配下表的模板名,直接套用:

| 触发关键词 | 模板 | 起点 | 步骤数 |
|-----------|------|------|--------|
| 缺陷管理 / 反馈 bug / defect | `defect-full-flow` | `/` 首页 | 5 步 |
| Ctrl+B / 命令面板 / 快捷键 | `shortcut-cmd-b` | 当前页 | 2 步 |
| Ctrl+K / 搜索 / 命令搜索 | `shortcut-cmd-k` | 当前页 | 3 步 |
| 周报 / 更新中心 / changelog | `changelog-weekly` | `/` 首页 | 3 步 |
| 知识库发布 / 智识殿堂 / library | `library-publish` | `/library` | 4 步 |

### B. 自定义(自然语言描述)

用户说"做一个从首页到海鲜市场搜索 XX 模板的演示",按以下流程:

1. **跑 flow-trace 或询问**,确认目标页面的 `data-tour-id` 锚点列表
2. **构造 Tour steps**:每步一个 selector + title + 可选 body
3. **生成 DailyTip JSON**
4. **三选一动作**:
   - `--apply` 直接 POST 到后端(需要当前 shell 有管理员 token)
   - `--print` 只打印 JSON
   - 默认:打印 curl 命令让用户贴到 terminal 执行

## 内置模板详情

### 1. 缺陷管理全链路 `defect-full-flow`

```json
{
  "kind": "card",
  "title": "缺陷管理全链路演示",
  "body": "跟着这 5 步走一遍:从首页进入 → 填写缺陷 → 选负责人 → 提交。",
  "actionUrl": "/",
  "ctaText": "从头开始",
  "targetSelector": "[data-tour-id=quicklink-defect]",
  "displayOrder": 5,
  "isActive": true,
  "autoAction": {
    "scroll": "center",
    "steps": [
      {
        "selector": "[data-tour-id=quicklink-defect]",
        "title": "第 1 步:首页进入缺陷管理",
        "body": "点首页的「缺陷管理」快捷入口,跳转到反馈页。"
      },
      {
        "selector": "[data-tour-id=defect-create]",
        "title": "第 2 步:点「提交缺陷」按钮",
        "body": "在缺陷页右上角点「+ 提交缺陷」打开表单。"
      },
      {
        "selector": "[data-tour-id=defect-title-input]",
        "title": "第 3 步:填标题 + 描述",
        "body": "标题一句话说清楚,描述支持粘贴截图和 markdown。"
      },
      {
        "selector": "[data-tour-id=defect-assignee-picker]",
        "title": "第 4 步:选负责人",
        "body": "搜索用户名或选择默认负责人(产品/后端/前端)。"
      },
      {
        "selector": "[data-tour-id=defect-submit]",
        "title": "第 5 步:点「提交」完成",
        "body": "提交成功后会收到「已创建」通知,开发修复后再收「已修复」。"
      }
    ]
  }
}
```

**前置检查**:这 5 个 `data-tour-id` 必须都存在于代码中。调用 skill 时先
跑 `grep -rn "data-tour-id=\"defect-\"" prd-admin/src` 核对,缺哪个提醒用户
补上(或走 bridge 技能自动加)。

### 2. Ctrl+B 命令面板 `shortcut-cmd-b`

```json
{
  "kind": "card",
  "title": "⌘/Ctrl+B 切换侧边栏",
  "body": "任何页面按 ⌘+B(Mac)/ Ctrl+B(Win)快速折叠/展开左侧导航。",
  "actionUrl": "/",
  "ctaText": "试一试",
  "displayOrder": 80,
  "autoAction": {
    "scroll": "none",
    "steps": [
      {
        "selector": "[data-tour-id=sidebar]",
        "title": "按下 ⌘/Ctrl+B",
        "body": "键盘按一下看侧边栏折叠效果。"
      },
      {
        "selector": "[data-tour-id=sidebar-toggle]",
        "title": "或点这个按钮",
        "body": "不习惯快捷键也可以直接点折叠按钮。"
      }
    ]
  }
}
```

### 3. Ctrl+K 命令搜索 `shortcut-cmd-k`

```json
{
  "kind": "card",
  "title": "⌘/Ctrl+K 一键搜 Agent",
  "body": "任何页面按 ⌘+K 弹出搜索,直接敲 Agent 名或文档标题即可跳转。",
  "actionUrl": "/",
  "ctaText": "打开搜索",
  "autoAction": {
    "scroll": "none",
    "steps": [
      {
        "selector": "[data-tour-id=home-search]",
        "title": "⌘/Ctrl+K 弹出搜索",
        "body": "按快捷键或点搜索框,全站 Agent/文档都在里面。"
      },
      {
        "selector": "[data-tour-id=command-palette-input]",
        "title": "输入关键词",
        "body": "敲 2-3 个字,列表实时过滤。"
      },
      {
        "selector": "[data-tour-id=command-palette-result-item]",
        "title": "回车跳转",
        "body": "上下箭头选中,Enter 跳转到目标 Agent/页面。"
      }
    ]
  }
}
```

### 4. 更新中心周报 `changelog-weekly`

```json
{
  "kind": "card",
  "title": "看本周都更新了什么",
  "body": "更新中心按周汇总所有 commit + PR,点每条能跳到 GitHub 代码。",
  "actionUrl": "/changelog",
  "ctaText": "查看更新",
  "autoAction": {
    "scroll": "center",
    "steps": [
      {
        "selector": "[data-tour-id=changelog-latest]",
        "title": "第 1 步:本周更新",
        "body": "最新版本在第一位,展开看每一天的改动。"
      },
      {
        "selector": "[data-tour-id=changelog-filter]",
        "title": "第 2 步:按模块过滤",
        "body": "只关心 prd-admin?在筛选器勾上它。"
      },
      {
        "selector": "[data-tour-id=changelog-entry-link]",
        "title": "第 3 步:跳到代码",
        "body": "每条记录点进去直接跳 GitHub commit/PR。"
      }
    ]
  }
}
```

### 5. 知识库发布 `library-publish`

```json
{
  "kind": "card",
  "title": "把你的知识发布出来",
  "body": "从上传文档、自动同步订阅源,到发布到社区知识库,3 分钟搞定。",
  "actionUrl": "/document-store",
  "ctaText": "开始发布",
  "autoAction": {
    "scroll": "center",
    "steps": [
      {
        "selector": "[data-tour-id=library-create]",
        "title": "第 1 步:新建知识库",
        "body": "点「发布我的知识」创建一个新的知识库。"
      },
      {
        "selector": "[data-tour-id=document-upload]",
        "title": "第 2 步:上传文档",
        "body": "拖入 PDF/Markdown/Word,也可以粘贴 URL 自动抓取。"
      },
      {
        "selector": "[data-tour-id=document-store-publish]",
        "title": "第 3 步:发布到社区",
        "body": "勾选「公开」后会出现在智识殿堂排行榜。"
      },
      {
        "selector": "[data-tour-id=document-store-sync]",
        "title": "第 4 步:设置自动同步",
        "body": "配置订阅源后系统每天自动拉最新内容。"
      }
    ]
  }
}
```

## 执行流程

1. **识别模板** — 匹配上表的关键词;没匹配就按 B 流程自定义
2. **前置校验** — 对模板里用到的每个 `data-tour-id`,grep 核对存在性;缺失
   的写在警告里,列给用户,让他决定"先补锚点"还是"先跳过这一步"
3. **输出 JSON + curl** — 打印完整的 DailyTipUpsert payload,并给出两种执行方式:

   ```bash
   # 方式 A:你自己贴到 terminal 执行(需要先 login 拿 token)
   TOKEN="<你的 token>"
   curl -X POST "$API_BASE/api/admin/daily-tips" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d @- <<'EOF'
   { ...JSON... }
   EOF
   ```

   ```bash
   # 方式 B:进管理后台 → 系统设置 → 小技巧 → 新建,把 JSON 字段一个个粘贴
   ```

4. **提醒 QA** — 演示写入后,提醒用户:
   - 登录目标账号,去首页看书图标是否自动弹出抽屉
   - 点「从头开始」,Spotlight 按 steps 一步步走
   - 每步点「下一步」验证 selector 能命中

## 扩展:自定义演示(B 流程)

当用户描述一个不在上表的演示时:

1. **听清楚目标**:起点 URL、终点动作、涉及哪些页面/按钮
2. **搜锚点** 或 **提醒加锚点**
3. **构造 steps**:3-5 步最合适,太多用户点烦,太少看不懂
4. **写 title(第 N 步:XX)+ 简短 body(一句话说清怎么做)**
5. **输出 JSON + curl**,跟 A 流程一致

## 和 CDS Bridge 联动(借鉴,不复制)

CDS 的 `bridge` 技能做的是**让 AI 通过原子动作操作预览页面**(snapshot /
click / type / spa-navigate);我们这里做的是**让用户照着演示操作页面**。
两者是同一抽象的两个方向。

### 借鉴要点

1. **动作词表对齐**:bridge 的 `click / type / scroll / spa-navigate` 和我们
   autoAction 的 `autoClick / prefill / scroll / steps` 是同一批动词,命名
   意图一致,未来可以跨技能迁移。

2. **录制 → 演示**:用 bridge 做 tour 录制的工作流(人工或半自动):
   - 管理员用 `bridge` 技能手动走一遍目标流程(`snapshot` 读 DOM,
     `click index:N` 操作元素)
   - 记录 bridge 每条命令对应的元素的 `data-tour-id`(从 snapshot 返回里提取)
   - 输出成我们的 `autoAction.steps`,交给 `create-tour-demo` 技能落库

   示例:
   ```bash
   # 1. 管理员在 CDS 预览页开 bridge session
   curl -X POST "$CDS/api/bridge/start-session" -d '{"branchId":"xxx"}'
   # 2. snapshot 读当前页面
   curl "$CDS/api/bridge/state/$BRANCH_ID"   # 得到 {elements: [{index, tag, attrs{data-tour-id}}]}
   # 3. click index:N,记下它的 data-tour-id
   curl -X POST "$CDS/api/bridge/command/$BRANCH_ID" -d '{"action":"click","params":{"index":7},"description":"点 +提交缺陷"}'
   # 4. 录完每一步后,用它们的 selector + title 构造 autoAction.steps
   ```

3. **跨项目复用**:因为 CDS bridge 针对**任意**预览项目,如果将来要把这套
   演示机制搬到其他项目,**先**把目标项目的关键按钮加上 `data-tour-id`,
   **再**用本技能按项目 URL 重新生成一组 DailyTip 配置即可。不需要改动
   前端组件。

### 不合并的理由

- CDS bridge 是**操作时代理**(AI 代人操作),DailyTip 是**演示时指引**
  (给人看怎么操作)。观众不同、时机不同。
- 合并会让一侧的改动牵连另一侧。**借鉴复用动词表,保持数据结构独立**。

## 不要做

- **不要直接改数据库** — 必须走 POST /api/admin/daily-tips
- **不要改前端代码** — 只产出配置数据,不碰组件
- **不要编造 data-tour-id** — 必须先 grep 确认存在,不存在就如实告诉用户
- **不要跳过前置校验** — 没锚点的演示等于空跑,用户体验会崩

## 参考链路

- 后端:`prd-api/src/PrdAgent.Api/Controllers/Api/AdminDailyTipsController.cs`
  - `POST /api/admin/daily-tips` 新建 tip
  - `POST /api/admin/daily-tips/seed` 一键植入 8 条默认 seed(非本 skill 的能力,仅参考)
- 前端:
  - `TipsDrawer.tsx` 右下角悬浮书 + 抽屉
  - `SpotlightOverlay.tsx` 按 autoAction 执行的落地页引导
  - `TipCard.tsx` 统一的卡片组件
- 锚点规范:`data-tour-id="xxx-yyy"`,见 `CLAUDE.md` 规则 #9
