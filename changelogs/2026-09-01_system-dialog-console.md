| polish | prd-admin | 系统弹窗改控制台形态：容器 8px、控件 6px、正文 12-13px，替换掉 22px 圆角 + 液态玻璃 + 44px 药丸按钮那一套 |
| polish | prd-admin | 弹窗新增贴底动作条（上分隔线 + 淡底），主操作反色、危险操作填色、次操作只描边 |
| refactor | prd-admin | 弹窗面板改实底并全部走 --dialog-* 双写 token，删掉浅色 / 性能模式 / 素色材质三条 !important 补丁与遮罩模糊 |
| feat | prd-admin | Dialog 新增 actions 与 tone 两个入参，危险弹窗标题前加红竖条 |
| test | prd-admin | 新增弹窗形态守卫：尺寸档位、Button 尺寸钩子接线、遮罩不模糊、token 双写、调用方不叠内边距 |
