| fix | cds | tsc-input-sha 子树锚点把 cds/pnpm-lock.yaml 与 cds/web/pnpm-lock.yaml 加进 git log path，覆盖"pnpm update 改 lockfile 但不改 package.json"导致 .d.ts 类型变化但 tsc 仍 skip 的边角（Bugbot Low 报告） |
