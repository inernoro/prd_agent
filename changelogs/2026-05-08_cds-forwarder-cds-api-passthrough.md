| fix | cds | forwarder ProxyHandler 加 `/_cds/api/*` passthrough(对齐 master proxy.ts:360-373):widget script 通过此前缀回调 master REST API,strip /_cds 前缀 + 加 x-cds-internal header + 转发到 master 端口 9900;否则 widget badge 显示但内部 fetch 全部 404 |
| feat | cds | ProxyHandler 增加 masterPassthroughHost / masterPassthroughPort 配置项(默认 127.0.0.1:9900),forwarder-main 通过 CDS_MASTER_PASSTHROUGH_HOST / CDS_MASTER_PASSTHROUGH_PORT / CDS_MASTER_PORT env 注入 |
| test | cds | 新增 2 个 ProxyHandler 测试:_cds/* path strip + 转 master / 普通 path 不被 passthrough,验证分流正确,1505 全绿 |
