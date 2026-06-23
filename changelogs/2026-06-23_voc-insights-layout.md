| fix | prd-admin | 修复 VOC 体验全景热力图「时铺满时留白 + 入场动画随机不播」：ResizeObserver 改用回调 ref（容器一挂载即测量），入场闸门绑到真实测量尺寸首帧 |
| refactor | prd-admin | VOC 桌面看板全景热力图升为主角约 2/3 满高，右栏约 1/3 还原排布（趋势整宽在上、痛点指数仪表盘 + 声道并排在下），仪表盘填满首屏视口、底部明细全宽下移滚动可见 |
| refactor | prd-admin | VOC AI 用户分析从底部内联面板改为点击触发的右侧抽屉（与端点下钻同一种抽屉），按钮文案改「AI 用户分析」 |
| fix | prd-admin | 修复 VOC 同时打开下钻抽屉与 AI 用户分析抽屉时 ESC 误关被盖住的下钻抽屉：ESC 改按视觉层叠关最上层（brief 先于 drill） |
