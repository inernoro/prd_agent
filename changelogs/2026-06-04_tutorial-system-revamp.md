| feat | prd-admin | 教程入口:点「本页教程」始终展示完整列表(不再「只有一套就直接开讲」跳过列表) |
| feat | prd-api | 教程难度分级(初/中/高)+ 经验值/等级:完成教程按难度攒经验(初10/中20/高40),progress 端点新增 xp/level/levelName/xpToNext,visible/progress 下发 difficulty+xpReward(难度缺省按步数推断,可显式上调) |
| feat | prd-admin | 头像徽章显示等级;学习中心新增等级/经验进度条 + 每条教程难度徽章 + 经验奖励 |
| refactor | prd-admin | 下线「系统设置→小技巧管理」编辑页 + 删除 AdminDailyTipsController(create/update/delete/push/seed/reset),教程统一为代码内置 seed(BuildDefaultTips),visible/progress 自动并入无需手动 seed |
| feat | prd-admin | 学习中心从百宝箱(wip)升为「基础设施」一级导航;首页顶部新增「教程中心」承接卡(展示等级+掌握度,点击进 /learning-center) |
