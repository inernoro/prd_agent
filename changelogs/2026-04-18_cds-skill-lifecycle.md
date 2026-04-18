| feat | skill | cdscli 新增 `update` 命令自升级（带备份+回滚）+ `version` 命令对比本地/服务端版本 |
| feat | cds | `/api/cli-version` 端点读取 cli/cdscli.py VERSION 常量（60s 缓存）|
| feat | skill | CLI 请求带 `X-CdsCli-Version` header，解析响应头 `X-Cds-Cli-Latest` 自动 stderr 提示"有新版" |
| docs | skill | 新增 reference/maintainer.md：维护者工作流（改技能源 → bump VERSION → push → CDS self-update 生效）|
| docs | skill | SKILL.md 顶部加"你是哪种身份"导航：消费方 vs 维护者两条路径分流 |
