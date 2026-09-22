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
