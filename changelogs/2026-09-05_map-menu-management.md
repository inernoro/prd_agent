| feat | prd-admin | 设置 → 导航顺序 新增「全部用户」视图：第一行是所有人的默认导航，其余每人一行，自定义的排前面、沿用默认的排后面，已下线菜单用虚线红框标出，支持按人重置为默认 |
| feat | prd-api | 新增全员导航总览接口与单用户导航重置接口（settings.read / settings.write） |
| refactor | prd-admin | 导航顺序编辑器改用 dnd-kit：自绘拖影、拖动时条目实时让位、分隔横杆可按面积放大并支持键盘排序，替换原生 HTML5 拖拽 |
| chore | prd-admin | 删除 MAP 左侧「模型」菜单及 /mds 页面（含首页快捷入口、全部能力入口、移动端适配注册、死脚本）；mds 权限点与 api/mds 读接口保留 |
| chore | prd-api | 菜单目录移除 mds 条目；平台密钥完整性通知与授权健康检查的处理入口改指向模型网关 / 请求日志，不再指向已删除页面 |
| feat | prd-admin | 全员导航总览新增「清理已下线菜单」：一键从所有人默认导航与全部用户个人导航里拔掉目录中已不存在的菜单 key，不重置任何人的顺序 |
| feat | prd-api | 新增 remove-tokens 接口：按 token 从默认导航配置与全部用户偏好中批量拔除（settings.write） |
| fix | prd-admin | 全员导航总览：旧前缀 id（如 utility:emergence）不再被误判为已下线；默认导航本地回写与加载同口径迁移 |
