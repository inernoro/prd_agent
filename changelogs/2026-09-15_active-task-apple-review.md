| refactor | prd-admin | 任务台圆圈语义统一为「做完了」，切换当前任务移到行尾「开始」 |
| feat | prd-admin | 任务台点圆圈改为乐观完成 + 底部补写「做成了什么样」+ 撤销 |
| feat | prd-admin | 任务台「加一件」改为行内新增，回车提交后接着敲下一条 |
| feat | prd-admin | 任务台桌面两栏（左侧 source list）/ 手机单栏 + 分段控件，救活历史页孤儿路由 |
| feat | prd-admin | 任务台浮层两端分形态：桌面贴顶按钮右对齐 / 手机底部升起，补 createPortal + ESC + 焦点陷阱 |
| feat | prd-admin | 任务台首次进入一次性新人指引（一屏三行，不做逐步高亮导览） |
| fix | prd-admin | DuePicker 过 18:00 后点「今天」会生成过去时间导致立刻逾期 |
| fix | prd-admin | DuePicker「自定」选中后展开状态收不起来 |
| refactor | prd-admin | DuePicker 自定日期改自绘月历网格，替掉 input type=date |
| fix | prd-admin | 任务台三处 whenLabel 拷贝合一并改用 serverNow |
| fix | prd-admin | 任务台 hover 规则收进 @media (hover:hover)，补 :active 与 reduce-motion |
| fix | prd-admin | 任务台字号全面改 rem，标题改换行不截断 |
| fix | prd-admin | 任务台过期时间补感叹号角标，不再只靠颜色表达状态 |
| fix | prd-admin | 任务台删除按钮不再隐形消失，投入过时间的显示为「放下」 |
| fix | prd-admin | 团队页轮询在标签页不可见时停跑 |
| feat | prd-api | 任务台新增撤销结案 POST {id}/reopen，PUT 支持补写 closingNote |
| polish | prd-admin | 任务台界面文案去掉「老板 / 让他」语气与解释性长句 |
| docs | doc | 任务台设计文档补两端分化与新人上手两节，债务台账补 4 条（拖拽排序 / 不可编辑 / 删除无撤销 / 我的任务不自刷新） |
