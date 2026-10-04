# 验收 driver

这里放**针对具体功能**的验收 driver，公共 harness 在
`.claude/skills/create-visual-test-to-kb/scripts/harness.mjs`（项目无关，不要在这里复制一份）。

## active-tasks-driver.mjs —— 任务台

关掉 `doc/debt.platform.active-tasks.md` 第 7 条用的那条脚本。它证明的不是「页面打得开」，
而是三条从没被真人跑过的链路真的成立：

| 链路 | 判据（机读，不只是截图） |
|---|---|
| 手工 | 回车后输入行还在（能连着敲）→ 两条都进列表 → 拖完顺序真的换了 → 刷新后做完的那条带着结论句还在 |
| AI 拆解 | 一段清单体文字至少拆出 3 条候选 → 勾选的那条真的出现在队列里 |
| 建议吸取 | 提一条后收件箱横幅出现 → 吸取整理出任务 → 吸取后横幅清零 |
| 两端 | 左栏能切管理视图；390px 无横向溢出 |

每条判据都写下 expected / actual，失败时不用回头猜它当时在比什么。
截图只作证据，不作判据 —— 截图只能证明「那一刻屏幕长这样」，证明不了「那条任务真的存在」。

```bash
export PWPATH=$(npm root -g)/playwright
export MAP_AI_USER='<账号>' MAP_ACCEPT_PASS='<口令>'
node scripts/acceptance/active-tasks-driver.mjs "$(python3 .claude/skills/cds/cli/cdscli.py --human preview-url | head -1 | awk '{print $NF}')"
```

沙箱里浏览器打不通真站（`ERR_CONNECTION_RESET`）时，先按 `sandbox-net` 技能搭隧道，
再把地址换成 `http://127.0.0.1:7801`，判据不变。

产出 `$ATB_OUT`（默认 `/tmp/atb-acceptance`）下的截图 + `manifest.json` + `verdict.json`。
`verdict.json` 是机读结论：`pass` / `conditional`（有 P1 失败）/ `fail`（有 P0 失败），
退出码非 0 即未通过，可以直接挂进流水线。

`active-tasks-fixture.txt` 是 AI 拆解那一步的输入 —— 一份真实的、会议纪要体的待办清单，
不是一行一件的干净列表。用干净列表测等于没测：按行切的老路子也能过。

## literary-mcp-user-journey.md —— 文学创作 MCP（主验收）

用户报的是「文学创作用起来难用、数据会乱」，所以验收也从用户提问题的地方开始：原样重演用户当时那句请求
（「这篇文章使用 MAP 平台进行配图，图片风格使用全域粉销风格，水印使用水印配置1」），
由一个只接了 MAP MCP 的普通智能体去做，执行者站在用户的位置用网页看结果。
共六幕：最初的请求 → 回 MAP 看结果 → 重画一张 → 改稿 → 网页上自己重新上传 → 收尾。
每一幕都写了「对智能体说什么」「看什么」「哪些现象算问题」。
文件本身就是发给执行者的原文，整段复制即可。

## literary-mcp-driver.py —— 文学创作 MCP（事后机器复核）

上一轮验收只问「图出来了没有」，于是三类问题全部漏掉：用户点名的风格/水印有没有真的用上、
网页与智能体轮流改同一篇之后数据还对不对、旧图有没有被删。这条 driver 专测这三类，
每条判据都走真实 MCP 网关（`/api/mcp`，与外部智能体看到的一致），网页侧用同一账号的登录态。

| 段 | 判据（机读） |
|---|---|
| 前置 | 指定的风格 / 水印存在且**不是**默认那套——否则「指定」与「默认」分不出来，判据永远绿 |
| 建稿 | 全角写法与 6 个标记能建；同一幂等键原样重试回同一篇、换内容报冲突；空描述被拒 |
| 生图 | 一次入队 6 张；回执里的风格/水印 ID 等于指定那套；原样重试不重复入队；换尺寸报冲突 |
| 闭环 | 600s 内 6 张都有 url，且 url 走水印存储路径；`watermark=none` 那张不走 |
| 交叉写 | 网页改一个标记后另外几张图一张不少；带标记改稿升版且旧图全进历史；网页重新上传正文后旧标记失效、历史不少 |

```bash
export MAP_BASE="$(python3 .claude/skills/cds/cli/cdscli.py --human preview-url | head -1 | awk '{print $NF}')"
export MAP_MCP_KEY='sk-ak-...' MAP_USER='<账号>' MAP_PASSWORD='<口令>'
python3 scripts/acceptance/literary-mcp-driver.py
```

执行者只做三件事：设变量、跑脚本、把 `$LIT_OUT/verdict.json` 原样贴回来，外加脚本最后打印的那两张截图。
不许改判据，不许把 FAIL 解释成 PASS——判断已经写在脚本里，不交给执行者。
