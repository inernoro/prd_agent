| feat | cds | Project 新增 aliasName / aliasSlug 两个可选字段; Settings → 基础信息 新增「显示别名」输入框,项目卡片 / 面包屑 / 删除确认 / Agent Key 签发弹窗全部走 aliasName \|\| name,用于解决「legacy 默认项目 name='prd-agent' 但用户希望显示别的」的显示困扰,不改 id / slug / 分支 id 前缀 |
| feat | cds | PUT /api/projects/:id 接受 aliasName (≤60 字符,空串清除) + aliasSlug (走 SLUG_REGEX,不能等于项目原 slug / 不能与其它 project slug / aliasSlug 冲突,空串清除); aliasSlug 当前仅存储,暂不影响分支 id 前缀,后续 PR 再做可选的 new-branch-prefix 开关 |
| test | cds | projects.test.ts 新增 6 个用例覆盖 alias 接受 / 清除 / 长度 / slug 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景 |
