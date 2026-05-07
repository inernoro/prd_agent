| perf | cds | self-update lockfile-hash fast-path：cds + cds/web 的 pnpm-lock.yaml + package.json 哈希命中 stamp 时跳过 pnpm install，单次 self-update 节省 30-50s |
| perf | cds | 自更新弹窗 healthz 轮询从 1.5s ×40 改为 0.5s ×60，密度 ×3，daemon 起来后 perceived 检测延迟从 750ms 平均降到 250ms；OK 后 reload 延迟从 600ms 缩到 200ms |
