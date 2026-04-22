| feat | prd-admin | TipsDrawer 重构成右下角悬浮书状态机:`collapsed`(默认显示书) / `expanded`(抽屉) / `hidden`(收到屏幕右边缘只露半截书脊) / `edge-peek`(鼠标贴右下 140px 区域时滑出),书图标改为 BookOpen,定位「教程总管」 |
| feat | prd-admin | TipsDrawer 抽屉头部新增「钉一下」(Pin / PinOff)按钮,锁定后小书永远完整显示、不会自动 collapse / hide;关闭按钮在非锁定时把书收到边缘,锁定时只关抽屉 |
| feat | prd-admin | TipsDrawer 推送降临(出现 isTargeted 定向 tip)时自动 expanded,5s 内用户无 hover/点击则自动 collapsed(徽章保留);pinned/hidden 状态用 sessionStorage 持久化(关闭标签页重置) |
| refactor | prd-admin | 小贴士后台 AutoActionEditor 改成「模板模式」:5 个引导模板分段控件(不引导 / 高亮 / 高亮+自动点击 / 高亮+预填 / 多步 Tour),选中后只显示该模板需要的字段,「高级配置」开关兜底完整字段(scroll / expand);大幅降低运营心智 |
