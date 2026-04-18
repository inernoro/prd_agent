| fix | prd-admin | 修复「管理标签」铅笔按钮进不了编辑态的回归：新增 editingTagSource（manage/quick/editMode）隔离三处入口，避免共用 editingTagIdx 导致 onBlur 连带退出；三处 setEditingTagIdx/Draft 重置统一收敛到 handleCancelInlineEditTag。 |
