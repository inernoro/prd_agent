| refactor | llmgw | 新增 lib/surface.ts 组件规格 SSOT：卡片内边距 / 次级块 / 容器间距四档 / 卡片操作行 / 主操作按钮规格，落实「同一角色只允许一种规格」 |
| fix | llmgw | 模型池三套指标展示收敛为一套：删掉 4 张只装一个数字的指标卡，汇总并入标题行小字；页头改 lg-page-heading，主操作统一 primary/sm，裸文字链接改 ghost 按钮 |
| fix | llmgw | Exchange 去掉 eyebrow 层；三步引导卡由常驻改为仅零数据时出现（并入空状态卡的有序列表，不再多一层盒子）；主操作按钮由大号带 icon 统一为 primary/sm 纯文字 |
| fix | llmgw | 按钮规格归一：sm 高度 30→32px 落进控件基准区间，按钮文字由 12px 提到 --fs-secondary（按钮文字是要读的，不是角标） |
| feat | llmgw | 排版漂移检测新增五个「规格种类数」维度（卡片内边距/圆角/容器间距/chip/主操作按钮），上限取自基准页自身而非拍脑袋的理想值 |
