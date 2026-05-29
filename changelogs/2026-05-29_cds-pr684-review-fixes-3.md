| fix | cds | restartPolicy 解析补齐 parseComposeFile / parseComposeString(此前只 parseCdsCompose 有),否则这两条路径解析的 compose 永远不带 restartPolicy、resync diff 检测不到(Cursor Bugbot) |
| fix | cds | [安全] POST /api/infra 在存储边界就 sanitizeDockerRestartPolicy,不只依赖 docker run 时校验,避免未净化值留在 state 被其他路径带进 shell(Cursor Bugbot) |
| fix | cds | toCdsCompose(项目级 /api/export-config 导出)infra 段补出 command/entrypoint/restartPolicy,修复导出再 import 丢失启动命令(minio 崩溃循环复现)+ restart 策略(Codex review P2) |
