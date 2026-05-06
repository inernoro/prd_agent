| fix | cds | 修复 GitHub App config 永远 undefined 的"幽灵 webhook 503"bug —— 抽 load-env.ts 独立模块，让 config.ts 顶部 side-effect import；self-loader 语义改为"空字符串占位也覆盖"，消除 self-update spawn 透传 stale 空值导致的二次失效 |
