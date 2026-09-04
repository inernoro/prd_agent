| fix | cds | 修复上手向导步骤 03 在窄屏没有前进出口——弹窗高度链在「只藏不卸」的包裹层断掉，面板长成内容自然高（1009px > 视口 844px），「确认这些技能」被裁在屏幕外且全链无可滚容器 |
| fix | cds | 窄屏底栏改两行排布，主操作独占满宽，不再被次要的「打开技能库」压过 |
| fix | cds | 修复窄屏下切走上手助手 tab 时它藏不掉——高度链规则的 display:flex !important 打败了 hidden，两个 tab 会一起铺在屏幕上 |
| test | cds | 新增 scripts/agent-starter-mobile-probe.mjs：真浏览器量四档窄屏下向导每一步主操作的 rect，接进 cds.yml 每个 PR |
| test | cds | 上手向导探针改为量每一步的真实出口（含开头两步的卡片），此前 action:null 让它跳过量测直接 DOM click，卡片被裁到屏幕外也全绿 |
| test | cds | 上手向导探针补两轴边界与命中测试，推进改用真实指针点击——原来只查上下且用合成 click，出口被横向推出屏幕或被浮层盖住时照样全绿 |
| test | cds | 探针新增 tab 隔离判据：切走后上手助手必须真的从屏幕上消失；前置缺失改判失败，不再静默 SKIP 放行 |
| test | cds | 整页窄屏布局冒烟加离线模式（自起前端 + 合成数据），接进 cds.yml 每个 PR——此前它从未被任何流水线调用过 |
| test | cds | 离线冒烟新增两道抓 fixture 漂移的判据：未登记的 API 路径直接报错、每个页面断言内容锚点——此前漏登记的端点会静默回空对象，页面走空态而冒烟照常绿 |
| test | cds | 补齐 13 条此前漏登记的 fixture 路径（靠新判据扫出来的），并补 task-schedule 定时任务合成数据，让桌面四档不再走空状态分支空转 |
| test | cds | profile-overrides 的合成数据键名改对（`profiles` 而非 `overrides`）——抽屉读 `profilesRes.profiles`，回错键名会被 `|| []` 吞成空列表，请求成功、判据全绿、profile 卡永远是空的 |
| docs | cds | 台账记下实测到的更大一块：离线模式下抽屉「配置」tab 整个是坏的（effective-env 形状对不上），而冒烟根本没切 tab，profile 卡从来不在覆盖范围内 |
| test | cds | 剩下三条没锚定的 fixture 正则一并收口（projects/:id/env、profiles、infra/*）——`/^\/api\/infra\//` 会吞掉整个 infra 家族，「未登记路径」判据在这三处仍可被绕过 |
| test | cds | 分支子路由 fixture 逐条登记并锚定 catch-all——原来那条不带 $ 的前缀会吞掉 /logs /metrics /resources 等六个子路由，让「未登记路径」判据形同虚设 |
| test | cds | 抽屉的内容锚点限定在抽屉容器内、且取抽屉独有的值（分支 previewSlug）——原来在整页 body 找分支名，那个串在抽屉背后的分支卡标题上也有，抽屉退化成空壳照样绿；容器找不到判失败，不静默放行 |
| test | cds | 内容锚点改用各页自己响应里的值：project-settings 取环境变量键名、cds-settings 取自更新分支名、发布中心取 /api/releases/center 自己的数据，不再用共享项目名或页面硬编码标题 |
| fix | cds | 探针跑失败时不再泄漏 dev server：浏览器启动挪进 cleanup guard，且 stop 改收整个进程组——只杀 `pnpm exec vite` 这个包装进程的话，真正的 vite 是孙进程会活下来占着 strictPort，下一次直接起不来 |
| fix | cds | 就绪判据累积输出并剥 ANSI，且不要求紧跟数字——vite 给耗时加粗，ANSI 码正好插在 `in ` 与数字之间，要求 `\d+` 在 CI 上整个匹配不上（实测 30s 超时），`\b` 本身已足够排除 `already in use` |
| fix | cds | dev server 的就绪判据改成带词边界的 `\bready in \d+`——端口被占时 vite 打的 `Port N is already in use` 里，`already in` 含有子串 `ready in`，旧判据据此判「起来了」，整套布局判据会对着另一个进程的响应跑完并全绿 |
| fix | cds | dev server 在就绪超时那条路径上也收进程组——上一处修复只覆盖了「浏览器起不来」，vite 起来了却没吐出就绪字样时 stop 还没构造出来就抛了，进程组照样没人收 |
| refactor | cds | 抽出 scripts/lib/vite-dev-server.mjs，两个布局探针共用一份 dev server 启动逻辑 |
| ops | cds | cds.yml 补 Chromium 安装与窄屏可达性判据步骤 |
| docs | cds | 台账记录实测出的三个判据盲区：内部容器溢出 / 卡片被压扁 / 被滚动祖先裁到视口外 |
| docs | cds | 改正 fixture 文件里一句给假安全感的注释：空态页面光导航就有一百五十多字，旧的「文字够多」判据根本拦不住 |
