| fix | scripts | 每日验收的 readScoped 改为参数传 scope（柯里化闭包在 page.evaluate 里取不到，五条用例全打哑） |
| fix | scripts | checkPageAlive 把 goto 与取证纳入 try/finally 关页，避免一条失败滚成后续 goto 超时 |
| fix | scripts | 视觉创作锚点跟随改版更新为「今天做什么图？」，旧文案已在改版时删除 |
| test | scripts | 补两条守卫：禁止柯里化取证函数、失败也必须关页（均已验证可测红） |
