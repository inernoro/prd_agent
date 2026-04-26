| fix | prd-admin | ReportEditor 在 getWeeklyReport 失败时不再静默白屏(report=null + isNew=false → 整个组件 return null,所有按钮看似消失);改为显式 toast.error + 渲染失败 fallback 卡(含返回列表按钮),用户始终能感知错误 |
| fix | prd-admin | reportAgentStore 的 loadTeams/loadTeamDetail/loadTemplates/loadUsers 在 res.success=false 时不再静默,显式 set error 触发顶部红条(避免 templates=[] 假象让「写周报」按钮被错误 disable) |
| fix | prd-admin | ReportEditor 顶部 toolbar 增加 flex-wrap + shrink-0 + ml-auto,窄屏 / zoom 放大 / 多按钮(autosave + AI 生成 + 保存 + 提交 + 删除)场景下「提交」按钮不再被挤出可视区 |
| fix | prd-admin | ReportMainView「写周报」按钮 disabled 时,在按钮下方追加可见的小字提示(「团队未配置模板，请联系负责人」),替代仅 title tooltip 的方案(移动端 / 触屏不可达) |
| fix | prd-admin | ReportEditor 状态枚举防御:当周报 status 不在任何 can* 集合时,DEV 模式下打印 console.warn,便于后续新增枚举值忘记同步前端时定位"按钮全部消失"问题 |
