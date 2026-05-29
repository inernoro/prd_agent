| fix | cds | [安全] infra restartPolicy 拼进 docker run 前按 Docker 合法策略白名单校验(no/always/unless-stopped/on-failure[:N]),非法值回落默认,杜绝 `no; touch /tmp/pwn` 类命令注入(Codex review P1) |
| fix | cds | infra resync execute 现在把 yaml 声明的 restartPolicy 落库(update + add 两路径),修复"检测到 restartPolicy 变化但不持久化、startInfraService 回落默认、预览永远报同一处漂移"(Codex review P2) |
