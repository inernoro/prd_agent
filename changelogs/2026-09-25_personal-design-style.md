| feat | prd-api | 新增「我的风格」：每人自己的网页生成风格（新建 / 编辑 / 删除 / 列表，按归属人隔离，每人最多 20 套），从自己的网页确定性提取配色、字体、字号、间距与版式 |
| feat | prd-api | 生成请求支持 personal:<id> 风格，服务端按编号 + 当前用户取出冻结进运行，风格名写进运行出处；预设 / 目录 / 我的风格三选一判据收在一处 |
| feat | prd-admin | 风格画廊新增「我的风格」区（标「我的」、可编辑重命名与删除），「做一个我的风格」打开创建弹窗：选网页或写描述 → 系统提取 → 核对「系统填写」项 → 保存并选中 |
| chore | prd-api | 新集合 personal_design_styles 登记数据同步分组与 DBA 索引清单（idx_personal_design_styles_owner_updated） |
