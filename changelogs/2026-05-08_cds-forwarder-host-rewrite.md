| fix | cds | forwarder ProxyHandler 把 Host header 改写为 upstream hostname:port(对齐 master ProxyService 行为),原始域名走 X-Forwarded-Host;之前透传外部域名导致容器内 vhost 不识别全部 404 |
