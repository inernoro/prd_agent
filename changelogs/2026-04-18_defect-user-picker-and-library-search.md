| fix | prd-admin | 缺陷详情弹窗关闭按钮定位到对话框右上角（showChat 时不再卡在 55% 分栏线上） |
| feat | prd-api | `/api/defect-agent/users` 返回 AdminUser 兼容形状并按「已解决缺陷数」降序返回，最积极解决缺陷的人排在最前 |
| feat | prd-admin | 缺陷提交面板（DefectSubmitPanel / GlobalDefectSubmitDialog）统一使用 `UserSearchSelect` 富选择器（头像/角色/活跃时间）替换原始 `<select>`，与「发起数据分享」一致 |
| fix | prd-admin | 缺陷提交按钮允许点击态保留；缺少「提交给」时改为该字段红色闪烁三拍（代替右上角 toast），视觉聚焦到真正需要填写的控件 |
| feat | prd-admin | 智识殿堂（LibraryLandingPage）新增搜索框：支持按知识库名称 / 作者 / 描述 / 标签模糊搜索，含空结果引导 |
| refactor | prd-admin | 统一用户选择器：OpenPlatformPage / AppsPanel / BindingPanel / EmailChannelPanel / IdentityMappingsPage / WhitelistEditDialog / DataSourceManager / TeamManager 全部替换为 `UserSearchSelect`（系统公认的富用户选择组件） |
