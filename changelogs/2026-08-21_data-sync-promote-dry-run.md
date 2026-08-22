| feat | prd-api | 试跑之后可以就地转正成一次真跑（`POST runs/{id}/promote`），不用再让人去源站点第二次同意 |
| feat | prd-api | 试跑成功后票据保留到转正或过期；真跑与失败照旧立刻交还源站作废 |
| feat | prd-admin | 试跑结果页新增「确认无误，开始真的搬」卡片，说明真跑照着刚才那一份执行、不重新取数 |
| test | prd-api | 补转正的三条边界守卫（至多一次的条件更新、不重新问源站、只有成功的试跑能转正）与「试跑不许交还票据」，均做过红绿闭环 |
| docs | prd-api | debt.platform.cross-instance-data-sync.md 新增 DS21，记录两次真实迁移卡死的根因与三条边界 |
