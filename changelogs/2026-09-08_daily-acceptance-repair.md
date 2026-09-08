| fix | scripts | 每日验收的 readScoped 改为参数传 scope（柯里化闭包在 page.evaluate 里取不到，五条用例全打哑） |
| fix | scripts | checkPageAlive 把 goto 与取证纳入 try/finally 关页，避免一条失败滚成后续 goto 超时 |
| fix | scripts | 视觉创作锚点跟随改版更新为「今天做什么图？」，旧文案已在改版时删除 |
| refactor | scripts | readScoped 拆到 scripts/smoke/lib/scoped-text.mjs，让守卫能真的执行它而不是扫源码 |
| test | scripts | 取证守卫改为按 page.evaluate 的真实机制重建并执行（可测红，且不因改写法误红） |
