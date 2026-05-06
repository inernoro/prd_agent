| feat | scripts | 新增 scripts/release-prepare.sh：合并 changelogs/ 碎片 + 把 CHANGELOG.md `[未发布]` 包裹成 `[X.Y.Z] - 日期` + 插入"用户更新项" bullet + commit，把发版"备料"环节从 5 步手工合并为 1 条命令 |
| feat | scripts | quick.sh 新增 `release-prepare` 入口（包装 release-prepare.sh）+ 补齐 `release` 入口（旧函数存在但未挂到 case 分发，导致 `./quick.sh release X.Y.Z` 之前根本跑不起来） |
