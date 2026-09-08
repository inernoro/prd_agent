| fix | scripts | 每日验收的 readScoped 改为参数传 scope（柯里化闭包在 page.evaluate 里取不到，五条用例全打哑） |
| fix | scripts | checkPageAlive 把 goto 与取证纳入 try/finally 关页，避免一条失败滚成后续 goto 超时 |
| fix | scripts | 视觉创作锚点跟随改版更新为「今天做什么图？」，旧文案已在改版时删除 |
| refactor | scripts | readScoped 拆到 scripts/smoke/lib/scoped-text.mjs，让守卫能真的执行它而不是扫源码 |
| test | scripts | 取证守卫改为按 page.evaluate 的真实机制重建并执行（可测红，且不因改写法误红） |
| ci | scripts | release_scripts 过滤器补登记 scripts/smoke/lib/** 与 WebPagesPage.tsx（只改被守文件的 PR 原本会跳过守卫） |
| test | scripts | 新增自检：守卫解析 ci.yml 过滤器，断言自己每个输入都在册（可测红） |
| docs | doc | 新增 debt.acceptance.daily-anchors 台账：五条锚点与归属页面无机械关联，记为 B 类不在本 PR 展开 |
