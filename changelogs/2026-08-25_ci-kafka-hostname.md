| fix | cds | 真容器测试补主机名，kafka 预设终于起得来（自我引用的 `kafka:9093` 在裸 docker run 下解析不了）|
| fix | cds | 容器日志诊断给足缓冲，JVM 服务的长日志不再 ENOBUFS 把失败原因整个吞掉 |
