| perf | cds | 源码 build/install 命令降调度优先级(nice，CDS_BUILD_NICE 默认 10)，让编译不饿死同机预览/代理，治预览根文档偶发卡几十秒；serve 命令保持正常优先级，非 docker 资源硬限 |
| perf | prd-admin | 首页智能体卡片封面图 lazy + async 解码，屏外封面滚动到视口才下载，砍掉首屏整片大图负载 |
