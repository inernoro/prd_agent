| fix | cds | 自更新历史进度条修复:重启前「等待分支操作排空」(可达 180s)此前不计入任何 step,导致各段之和远小于总耗时——进度条大片留白、看不出时间去哪了。后端把排空等待计入 `timings.drainMs`(self-update + self-force-sync 两处),前端进度条新增「等待排空」段 + 把残余未计量时间补成「其他」中性段铺满进度条 + 新增「总计」chip 让账对得上 |
| feat | cds | 进行中的自更新新增「预计进度条」:以历史成功记录各阶段中位数当预期时间线,按当前阶段 + 已用时长把对应段填实、未到的段淡显,并显示「已用 Xs · 预计约 Ys」,让用户对"还要多久"有大致预期而不是空盯秒表;超出预期时高亮提示 |
| fix | cds | `fmtMs` 时长格式 ≥60s 改用「X.X min」,180s 排空等待等长耗时更易读 |
| feat | cds | 预计进度条左侧显示总进度百分比 + 「预计还需 ~Zs」倒计时(超预期封顶 99%) |
| fix | cds | 修复进行中进度条阶段映射(Bugbot #716):①`nginx-render`/`cache`/`analyze` 不再误归到末尾重启段而跳到 ~100%;②后端排空等待前先把 step 切到 `drain`,UI 实时高亮「排空+重启」段而非停在 web-build 干等 180s;③`validate-timings`/`validate-done` 等过渡步骤改走 elapsed 兜底,不再误高亮类型校验。step→段改用精确映射表,过渡步骤按已用时长定位 |
| fix | cds | 预计进度条逐段兜底(Codex #716):某段在历史里没样本(旧历史缺 drainMs / hot 模式缺后端段)时用基线值补上而非留 0 宽,避免新加的排空+重启段零宽、ETA 漏算那段最长 180s 的等待 |
| fix | cds | 预计进度条时钟对齐(Bugbot #716):进度条 elapsed 改以后端 `activeSelfUpdate.startedAt` 为锚点,与同源的 step 配同一时钟,缺失再退回客户端 runStartedAt。修从本 tab 触发更新时百分比/段填充/「预计还需」与真实阶段对不上;同时面板副标题「执行中 · Xs」也改用同一 elapsed,避免标题与进度条「已用」打架 |
| fix | cds | `validate` 步骤不再钉死 install 段(Codex #716):后端整段校验只发一个 `validate` step(install+tsc 合一),钉死 install 会让 tsc 期间进度条卡住;改为走 elapsed 兜底,随时间从 install 平滑推进到 tsc |
| fix | cds | 自更新历史数据源上移(Bugbot #716):进度条与历史列表共用 `useSelfUpdateHistory` 一份数据,不再各自 fetch 同一 endpoint,消除进度条挂载初期空 fetch 期间误显「暂无历史 · 粗略估算」 |
