| feat | cds | 新增 AI 控制态动效三方案 demo 页（数据流轨道 / 思考脉冲 / 工位接管），含基线对照与双主题切换 |
| fix | cds | 修复方案 C 徽章环形巡光甩出徽章：扁矩形不能转元素，改转 conic 渐变角度 |
| feat | cds | 方案 C 阶段信息移入页脚闲置空间，左轨与页脚轨改由同一份状态驱动 |
| refactor | cds | 进度轨段数改为完全由数据决定，新增 staged/counted/indeterminate/heartbeat 四档退化与超时/失败两种异常态 |
| feat | cds | 分支卡落地方案 C：环境光扫掠 + AI 进度轨（staged/indeterminate/heartbeat 三档）+ 徽章环形巡光，页脚展示 AI 当前动作 |
| fix | cds | 修复 AI 进度轨方向修饰类被 Tailwind 摇掉：@layer components 里的规则不能用模板拼类名 |
| fix | cds | 修复分支详情抽屉滚动后被截断：page-enter 动画的 forwards 填充让滚动容器成了 fixed 的包含块 |
| polish | cds | 分支名改用等宽字体，对齐 llmgw 日志的英文字形 |
| polish | cds | heartbeat 档改用脉冲点替代无意义横线，补最近活动时间；浅色模式收敛环境光与边框 |
| test | cds | 改写反向锁死的 ShinyText 用例为契约断言，新增段数守卫、Tailwind 摇树守卫与 page-enter 包含块守卫 |
| chore | cds | 删除已无引用的 cds-ai-active-rail 与 cds-ai-rail-breathe |
