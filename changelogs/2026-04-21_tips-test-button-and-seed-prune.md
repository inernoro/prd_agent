| fix | prd-admin | 点教程小书或展开抽屉时立刻 `load({force:true})`,不再等 60s 轮询;管理员推送后用户下一次点书就能看到新 tip,修复「推送了还是 3」的延迟感 |
| refactor | prd-api | 精简 DailyTip seed:删掉 5 条只有单步 scroll 的短 tip(search/marketplace/library/updates/emergence);保留 3 条真流程(defect 4 步全链路 / report 多步 / toolbox prefill),让 seed 每条都是「完整演示」 |
| feat | prd-api | DailyTip `defect-full-flow` seed 扩展成 4 步 Tour:打开提交面板 → 写标题+描述 → 选负责人 → 点提交;对应前端 DefectSubmitPanel 新增 `defect-description / defect-assignee-picker / defect-submit` 3 个 data-tour-id 锚点 |
| feat | prd-admin | DailyTipsEditor 每条 tip 操作栏新增 `Play` 试播按钮:不走推送,直接在当前账号触发一次 `writeSpotlightPayload + navigate`,管理员保存后立刻看效果,消除「改完不知道对不对」的焦虑 |
| feat | prd-admin | PushDialog 新增「推给我自己」快捷按钮:一键把 tip 推给当前登录账号,每次重置 delivery 状态方便反复测;补齐管理员端到端自测闭环 |
| docs | .claude/skills | `create-tour-demo/SKILL.md` 补「和 CDS Bridge 联动」章节:说明 bridge 的 snapshot/click/type 动作词表和我方 autoAction 同源,可用 bridge 录制再导出成 `autoAction.steps`;强调借鉴不合并,保持两套数据结构独立 |
