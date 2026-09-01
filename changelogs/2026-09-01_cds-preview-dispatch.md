| feat | cds | 新增 `POST /api/preview-dispatch`：由服务端判定「本次改动波及哪些项目、各自有哪些已发布入口」，与 push 分发共用同一份作用域判据 |
| feat | cds | 预览地址输出格式定为 `[项目 · 入口] URL`，项目只有一个入口时收缩成 `[项目] URL`，多项目全部列出、没有主从 |
| feat | cds | 取不到地址时分三种情形说清（与该项目无关 / 还没有这条分支 / 分支在但没有入口），不再压成一句取不到 |
| feat | cds | preview-dispatch 按凭据过滤可见项目：项目级凭据只看得到自己那个项目，别人的项目名与地址一概不出现 |
| feat | cds | cdscli preview-url 改走服务端派定，新增可选 `--changed-since`；老版本 CDS 自动回退旧路径，不破坏既有技能 |
| docs | cds | preview-url 技能同步决策链路与输出格式；cdscli 与 cds 技能版本号同步到 0.15.0 |
| test | cds | 补预览派定判据 8 例与路由 6 例，含可见性隔离与「未波及仍出现在结果里」 |
