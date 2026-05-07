| perf | cds | self-update web build 增第二级 fast-path：通过 `git log -1 -- cds/web` 锚点判断 cds/web 子树自上次构建以来是否变过，未变则复用 dist + 滚动 .build-sha 到当前 HEAD，纯后端改动的自更新省掉 30-90s vite build |
