| fix | cds | 真容器测试的互斥此前从未生效：beforeAll 引用了一个文件里不存在的变量，CI 直接 ReferenceError，kafka 一直在和别的容器抢资源的情况下起；改成整文件取一次槽位 |
| fix | cds | kafka 起不来时改为打印真正的报错行而不是日志尾巴：JVM 把致命原因打在开头，尾巴几十行全是优雅关闭的 INFO，两轮 CI 拿到的都是噪音 |
