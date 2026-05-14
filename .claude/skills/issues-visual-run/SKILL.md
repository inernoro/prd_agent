---
name: issues-visual-run
description: 24h 视觉测试执行者 Agent 的逻辑。手动触发后从仓库拉取所有 label = visual-test:pending 的 issue，按子 issue body 的矩阵跑用例，回评论失败项 + 截图 + 严重级，或 /visual-pass 通过。完全不创建新 issue。触发词："/issues-visual-run"、"执行视觉验收"、"视觉测试接单"、"visual test run"。
---

# Issues Visual Run — 24h 视觉测试执行者

> 视觉测试执行者 Agent 的"接单 → 跑测 → 回报"逻辑。
>
> **本技能不开 issue**（那是 `/issues-visual-create` 的活）。只读取已存在的 `visual-test:pending` issue、按 issue body 的矩阵跑、回评论。
>
> 协议本体与 label 体系见 `doc/rule.issues-system.md`。模板演化讨论在 #605。

## 0. 何时触发 / 何时别用

**用本技能**：
- 24h 调度命中 `visual-test:pending` 队列
- 用户手动让你"过一遍视觉验收待办"
- 开发者修了 P0/P1 后让你"重测受影响项"

**别用**：
- 改协议、改模板 → 去 #605 评论
- 自己想测但还没开 issue → 用 `/issues-visual-create`
- 通用 issue 维护 → 用 `/issues-autofix`（且本技能与之**互斥避让**）

## 1. 接单条件（全部满足才进）

- label 含 `visual-test:pending`
- label 不含 `agent-processing` / `visual-test:reviewing` / `visual-test:passed` / `visual-test:blocked`
- issue 标题以 `[visual-test]` 开头
- issue body 满足"模板 v0.x 子 issue 模板"结构（含 §1-§6 必填项）

不满足任一 → 跳过，**不留痕**。

## 2. 并发锁（claim-then-verify）

> GitHub "Add labels" API 对**已存在**的 label 不返回失败，仅返回当前 label 集合。所以不能靠"加 label 失败"作为 CAS 锁——两个 worker 都会"成功"。必须用 claim 评论 + 再读 verify 模式。

### 启动 reaper（每次 sweep 第一步，扫死锁）

§8 单 run 内 `max_minutes_per_issue` timeout 救不了"worker 崩溃 / 容器重启"导致的死锁——崩溃后没人执行清理。§1 接单条件又只看 `visual-test:pending` 且拒绝 `agent-processing`，issue 会永久卡死。所以每轮 sweep 必须先跑 reaper：

1. `GET /repos/.../issues?labels=agent-processing&state=open`（不带 `visual-test:pending` 筛选，扫所有挂锁的 issue）
2. 对每条命中：找该 issue 评论里**最新**的 `visual-run:*:claim:*` 指纹时间戳
3. 该时间戳距今 > **reaper 阈值**（默认 30 分钟，必须 > `max_minutes_per_issue`）**且**该 run_id 没有对应 `:terminal:` 指纹 → 认定为崩溃残留：
   - 删 `agent-processing` label
   - 加回 `visual-test:pending` label（重新入队，等下一轮接单）
   - 评论：`reaper 重置：上一次 run_id={X} 在 {ts} 接单后未完成（>30 分钟无终态指纹），可能为 worker 崩溃。已恢复为待接单状态`
4. 不命中阈值的（还在合理处理时间内）→ 保留不动

### 接单阶段

1. **预检**：读 issue 当前 labels，若已含 `agent-processing` → 跳过
2. **声明 claim**（连续执行，允许非原子）：
   a. 加 label `agent-processing`
   b. 删 label `visual-test:pending`（与 SSOT `doc/rule.issues-system.md` §2.2 一致）
   c. 发评论：`已接单 · 预计 N 分钟 · run_id={uuid}`，**末尾必须含**指纹 `<!-- visual-run:{run_id}:claim:{iso8601-ts} -->`
3. **verify**（等 3-5 秒让其他 worker 落地后）：
   a. 重新拉取 issue 全部评论，grep 所有 `<!-- visual-run:*:claim:* -->` 指纹
   b. **过滤掉已退出的 claim**：若评论里同 run_id 既有 `:claim:` 又有 `:terminal:` **或** `:withdrawn:` 指纹 → 已完成/已撤回，剔除。只有"有 claim 无 terminal 无 withdrawn"才算活跃 claim。否则历史 loser 的悬空 claim 永远占据最早位置，新 round 永远输给它
   c. 在活跃 claim 池里按 ISO 时间戳升序排序，**最早**的为 winner（同毫秒则比 run_id 字典序）
   d. 本 run_id 是 winner → 继续 §3 执行矩阵
   e. 本 run_id 是 loser → **静默 back-out**：
      - 发评论：`撤回 run_id={uuid}，已被 run_id={winnerId} 抢先`，**末尾必须含**指纹 `<!-- visual-run:{run_id}:withdrawn:{iso8601-ts} -->`（否则 §2 b filter 认不出本 claim 已退出，会永久占据最早位置，让后续 round 永远输给历史 loser）
      - 判断 winner 是否仍在持锁（检查评论中 winnerId 是否已有 `visual-run:{winnerId}:terminal:*` 指纹）：
        * **winner 仍活跃**（无 terminal 指纹）：不动任何 label（winner 在用 `agent-processing` 持锁）
        * **winner 已完成**（已有 terminal 指纹）：**必须删 `agent-processing`**——loser 在 winner 收尾后才晚到 step 2，把锁加了回来；不清掉会让 issue 永久卡死（§1 接单条件拒绝含 `agent-processing` 的 issue，开发者后续移除 `visual-test:reviewing` + 加回 `visual-test:pending` 后本技能仍会跳过）
      - **不要**恢复 `visual-test:pending`（winner 已处理；恢复会再次入队造成无限循环）
      - 跳过本 issue，处理下一个

### 处理结束（仅 winner 执行，**顺序严格**）

> 终态指纹**必须**在删 `agent-processing` 之前发布。否则中间窗口里延迟 loser 看到"无 lock 又无 terminal"，会按 §2 e 的"winner 仍活跃"分支不动 label，loser 自己后加的 `agent-processing` 残留，issue 卡死。

1. 加对应终态 label（`visual-test:reviewing` / `visual-test:passed` / `visual-test:blocked`）
2. 兜底再次确认 `visual-test:pending` 已不在 issue 上（防御接单阶段在 race 下未删干净）
3. 发终态评论，末尾追加 `<!-- visual-run:{run_id}:terminal:{iso8601-ts} -->` 指纹（**先发指纹**）
4. 删 `agent-processing`（**最后释放锁**，此时延迟 loser verify 已能读到 `:terminal:` 指纹，会走 §2 e 的"winner 已完成"分支正确清理自己加的锁）

## 3. 执行矩阵

读 issue body §3 勾选的矩阵，逐项跑。

**双主题强制**：即使用户漏勾，dark + light 都必须跑（cds-theme-tokens.md 是硬规则）。

**视口默认**：未勾选时按 `1440×900` 跑。

**截图规约**（首次执行者上线时在 #605 §五 第 1 问对齐）：
- 格式：PNG（单图）/ MP4（短交互）
- 命名：`{issue#}-{viewport}-{theme}-{state}-{check#}.png`
- 上传：评论里直接附图，或托管到 GitHub Issues 自带 CDN

## 4. 硬约束自动化清单（§4 10 条）

按"机器化优先 + 人工兜底"策略：

| 检查点 | 机器化方式 | 兜底 |
|---|---|---|
| 无 emoji | 截图 OCR + 表情符号正则扫描 | 人工目视 |
| 白天无暗色 modal | 浏览器自动化抓主题切换后 modal 背景色 RGB，比对 `--bg-*` 系列 | 人工目视 |
| Modal createPortal + min-h:0 | DevTools 注入脚本检查 `position: fixed` 元素是否挂在 body 直系 | 人工 |
| 撑满视口 | viewport 高度 vs body scrollHeight，差 > 100px 报缺失 | 人工 |
| 空状态有引导 | 检测空列表区是否含 `<button>` / role=button | 人工 |
| LLM 面板模型名 | DOM 抓 `[data-llm-model-badge]` 或字符串"模型: " | 人工 |
| >2s 静止 = 缺陷 | 录屏帧差检测，连续 2s 像素差 < 阈值 = fail | 人工 |
| 输入零摩擦 | 检测 form 是否含 input[type=file] / select / placeholder 含模板 | 人工 |
| 画布手势统一 | 模拟 wheel + ctrlKey + pinch，断言事件被 preventDefault | 人工 |
| MAP Loader | **源码 grep**：在改动文件里搜 `from ['"]lucide-react['"]` 行是否 import 了 `Loader2`，以及 JSX 是否裸用 `<Loader2`（DOM 渲染后是 svg，抓不到组件名，必须查源码） | 人工对比设计稿 |

无法机器化的，必须截图 + 人工目视，**不允许沉默跳过**。跳过的视为该 issue `visual-test:blocked`。

## 5. 失败回报格式（评论 body，与 §7 协议对齐）

```markdown
## 失败清单（按严重级排序）

| # | 检查点 | 视口 | 主题 | 截图 | 问题描述 | 严重级 |
|---|---|---|---|---|---|---|
| 1 | Modal 高度 | 1440×900 | dark | ![](url1) | Modal 超出视口底部 60px,内容截断 | P0 |
| 2 | 模型名展示 | 1440×900 | light | ![](url2) | LLM 面板顶部缺少模型名 chip | P1 |
| ... |

## 已通过项

- §3 矩阵全部勾选项的其他维度
- §4 硬约束第 1,3,5,6,7,8,9 条

## 备注

- 第 4 条「页面撑满视口」无法机器化判定,转人工目视
- 全部用例耗时 N 分钟,run_id={uuid}

<!-- visual-run:{run_id}:terminal:{iso8601-ts} -->
```

**严重级判定**：
- **P0** 阻塞合并：白天黑底、emoji 出现、Modal 撑破屏幕、登录走不通、空状态无 CTA
- **P1** 必须修：模型名缺、加载组件不统一、双主题样式不一致
- **P2** 可延后：配色微调、间距 1-2px
- **P3** 优化建议：动效、文案

终态：
- 至少有一条 P0/P1 → label `visual-test:reviewing`（等开发者修）
- 全部 P0/P1 清零（只有 P2/P3 或无问题）→ 评论 `/visual-pass` + label `visual-test:passed` + 关闭 issue
- 环境不通 / 模板填不全 → label `visual-test:blocked` + 评论说明缺什么

## 6. 重测策略

开发者修复后会评论 `已修 commit <hash>` + 移除 `visual-test:reviewing` + 加回 `visual-test:pending`。

重测时**不需要全量重跑**，按"受影响项 + P0 全量回归"策略：
1. 读修复前评论里所有 P0/P1 失败项
2. 仅重跑这些项 + 该 issue 的 P0 全量回归（防止改 A 坏 B）
3. P2/P3 在原 issue 标记"已知遗留",不重测

## 7. 工具依赖

- `mcp__github__list_issues` 拉 `visual-test:pending` 队列
- `mcp__github__pull_request_read` / `mcp__github__get_commit` 读关联 PR/commit
- `mcp__github__add_issue_comment` 回报失败/通过
- `mcp__github__issue_write`(update) 改 label
- `bridge` 技能 — 操作 CDS 预览页面（鼠标轨迹、截图、状态读取）
- Playwright / Puppeteer / Chrome DevTools Protocol — 矩阵化跑测

## 8. 失败兜底

- 预览域名 5 分钟内拉不起来 → `visual-test:blocked` 评论"预览未就绪,检查 /cds-deploy 状态"
- issue body 模板填不全 → `visual-test:blocked` 评论缺什么字段
- 工具调用失败 → 重试 2 次后 `visual-test:blocked` 评论
- 单 issue 处理超 30 分钟 → `visual-test:blocked` + `agent-timeout` 评论

## 9. 协议演化反馈

每次跑完后,如果发现:
- 哪条检查点从来过不了 / 总是误报
- 哪个失败列名不够用
- 哪个严重级口径不清

**不要**改本技能,**直接去 #605 评论建议**。维护者会 bump 模板版本,本技能下次跑时自动按新版本。

## 10. 绝对禁止

- 不创建新 issue（那是 `/issues-visual-create`）
- 不动 `protected_paths`（同 `/issues-autofix`）
- 不 self-pass（评论 `/visual-pass` 必须基于矩阵跑完）
- 不输出 emoji（CLAUDE.md §0）
- 不沉默跳过无法机器化的检查点（必须 blocked + 说明）
- 不和开发者反向追问（只回报,不要"请问你的预期是..."）

## 11. 上下游

- 上游：`/issues-visual-create`（开单方）/ `/cds-deploy`（保证预览就位）
- 下游：开发者修复 push 后 → 重测循环
- 兄弟：`/issues-autofix`（互斥避让,本 issue 不归它管）
- 协议演化：#605 评论
