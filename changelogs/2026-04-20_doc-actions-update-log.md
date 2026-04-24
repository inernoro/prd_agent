| feat | prd-desktop | 文档右键菜单扩展：主文档新增"更换 PRD"，资料文档新增"替换文件"+"删除"（自研 ConfirmDialog 二次确认）|
| feat | prd-desktop | 更新通知弹窗新增"最近更新"列表，展示最近 1 个月 prd-desktop 条目（≥3 条），可展开查看全部 |
| chore | scripts | 新增 build-recent-updates.mjs：从 CHANGELOG.md 生成 recent-updates.json 供桌面端读取，绑定到 dev/build/tauri:dev/tauri:build pre-hook |
