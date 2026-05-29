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
- label 不含 `visual-test:reviewing` / `visual-test:passed` / `visual-test:blocked`
- issue 标题以 `[visual-test]` 开头
- issue body 满足"模板 v0.x 子 issue 模板"结构（含 §1-§6 必填项）

不满足任一 → 跳过，**不留痕**。

## 2. 处理流程（单实例假设，无锁无 verify）

> **前置假设**：本技能由用户**手动触发**，每天最多一次，同时刻只有一个实例运行。在这个假设下不需要分布式锁、claim-verify、reaper 等机制。详见 `doc/rule.issues-system.md` §0。
>
> 如果未来扩展为自动 cron / 多实例并发，需要重新设计协议（git history 里有一版 v1.0 的完整并发协议可参考）。

**单 issue 完整流程**：

1. 按 §1 接单条件过滤
2. 在 issue 上发评论"已接单 · 预计 N 分钟 · run_id={uuid}"（让人工审核者知道）
3. 按 §3 执行矩阵跑测试
4. 处理结束（**顺序严格：评论先于 label 切换**）：
   - **先发**终态评论（详见 §5 失败回报或 §8 通过模板），末尾追加幂等指纹 `<!-- visual-run:{run_id}:{今日日期 YYYY-MM-DD} -->`
   - **后加**对应终态 label（`visual-test:reviewing` / `visual-test:passed` / `visual-test:blocked`）+ 删 `visual-test:pending`
   - 顺序原因：若先切 label 后发评论，崩在中间会让 issue 离开 pending 队列但没结果，后续 sweep 不会再扫到 → 测试结果永久丢失。反过来则最坏情况是"评论已写但 label 漏切"，下次 sweep 因 issue 仍在 pending 队列会重新接单（重复跑一次但有结果，可接受）

**失败处理**：
- 单 issue 处理超 30 分钟 → 加 `visual-test:blocked` + 评论"超时跳过"
- 预览域名拉不起来 / 模板填不全 → `visual-test:blocked` + 评论说明
- 工具调用连续失败 ≥ 2 次 → 跳过，下次手动跑会再试

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

<!-- visual-run:{run_id}:{今日日期 YYYY-MM-DD} -->
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
- `bridge` 技能 — 已暂停默认使用；Bridge HTTP 轮询关闭期间不要依赖它操作 CDS 预览页面
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
