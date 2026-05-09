| feat | cds | forwarder ProxyHandler 加 widget injection(HTML 200 解压 gzip/br/deflate + 在 </body> 前注入 buildWidgetScript)对齐 master 行为,左下角分支 badge 恢复显示 |
| feat | cds | forwarder ProxyHandler 加 cookie cache control(cds_branch cookie 存在时响应头加 cache-control=no-store + Vary=Cookie),对齐 master proxy.ts:971-973 |
| feat | cds | forwarder upstream 错误响应分流:浏览器(Accept: text/html)返回友好 HTML 自动刷新页,API 返回 JSON{error,code,hint};对齐 master proxy.ts:1074-1092 |
| feat | cds | forwarder 增加每请求 console.log forward 日志 + 错误码 hint(ECONNREFUSED 等翻译为可读中文),debug 真相之源 |
| feat | cds | forwarder handleUpgrade(WebSocket)对齐 handle() 的 X-Forwarded-{Proto,Host} 设置,行为一致性 |
| feat | cds | RouteRecord 加 branchName 字段(原始 git 分支名),供 widget injection 显示;publisher 写入分支 entry.branch |
| test | cds | 新增 5 个 ProxyHandler 测试:cookie cache / widget injection (基础+无 branchName 跳过) / gzip 注入 / brotli 注入,1503/1503 全绿 |
