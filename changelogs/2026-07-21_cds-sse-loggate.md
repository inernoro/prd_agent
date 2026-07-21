| fix | cds | forwarder 代理响应剥掉 hop-by-hop 头(Connection/Keep-Alive/Transfer-Encoding 等):master SSE 的 Connection: close(防 nginx upstream 池复用死 socket,保留)不再透传到 HTTP/2 客户端连接,修复 /api/branches/stream 约 2.7 分钟 ERR_HTTP2_PROTOCOL_ERROR 断流 |
| perf | cds | http 请求日志治理:成功 GET 读请求(轮询/控制面/静态)按 1:10 采样落库(非 GET/错误/SSE/部署/容器操作全保留,在途请求实时面板不受影响);写链加 500 条有界背压,Mongo 慢时丢弃非错误记录而非无界积压 |
