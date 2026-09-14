| feat | prd-admin | 藏书阁手机档按 390 设计终稿重做：落地页与卷页拆成两级导航，七卷改 iOS 分组清单，处境卡横滑 |
| feat | prd-admin | 藏书阁手机档新增整屏答题与结果页（逐题对错 + 解析 + 错题指向的书），替代桌面弹窗 |
| feat | prd-admin | 藏书阁手机档新增整屏团队看板，结论先行（最薄弱的一卷）再给每卷通关人数与成员明细 |
| refactor | prd-admin | 抽出 useExamSession 与 useTeamBoard 作唯一判定源，桌面与手机共用，避免两侧各自算分与各自防御 |
| refactor | prd-admin | 手机档版式档位全部收敛到 appStoreTokens；粗野骨架（3px 墨边 / 硬投影 / 整卡五色底）退出手机档 |
| test | prd-admin | 新增 14 条手机档守卫（深链解析、四屏接线、档位出处、墨边退场、桌面未被改动），并补 e2e 手机端两级导航双主题闭环 |
