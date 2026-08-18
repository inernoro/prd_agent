| fix | cds | redis 备份改由 CDS 从自己的服务定义取口令、经 stdin 送进容器，修好最后一个因「口令只有 CDS 知道」而失败的 redis |
| security | cds | 凭据一律走 stdin（docker exec -i sh -s），不进宿主命令行；加接线守卫禁止回退到 docker exec -e / sh -c 带密码 |
