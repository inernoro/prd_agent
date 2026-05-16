| feat | prd-admin | 网页托管：来源/排序筛选下拉改用统一 Select 组件，告别原始原生 select |
| feat | prd-admin | 网页托管：拖文件到站点卡片显示"替换此网页"提示，松手后二次确认再覆盖 |
| feat | prd-admin | 网页托管：分享链接复用已有未吊销同类型链接（无密码/有密码各一条），吊销后才重新生成，分享统一走数字短链 |
| refactor | prd-admin | 网页托管：移除卡片"访问"按钮，访问统一走无密码分享链接的字母 token 地址 /s/wp/{token}（与分享数字短链 /s/{seq} 彻底分开、判断独立），来源标签仅非手动上传时展示 |
| fix | prd-admin | 网页托管：分享/访问链接复用尊重所选有效期，复用链接寿命不得超出所选窗口；访问链接仅复用永不过期链接，杜绝过期后 404 |
| fix | prd-api | 网页托管：分享链接「复用 vs 新建 + 有效期刷新」下沉到服务端 CreateShareAsync 单一闭环，不再依赖前端分页列表（杜绝链接数超分页上限后去重失效）；复用时有效期刷新为本次所选窗口，既不"开盖即废"也不超出所选 |
| fix | prd-admin | 网页托管：替换网页 reuploadSite 加 try/catch/finally，网络异常不再永久锁死弹窗按钮；列表视图访问地址与网格视图统一走 /s/wp/{token} |
| fix | prd-api | 网页托管：分享链接新增 Purpose 字段（share/visit），访问便捷链与用户分享物理隔离——访问流程不再复用/篡改用户主动创建的限期分享，visit 链不进分享管理列表；旧记录无字段按 share 兼容 |
| fix | prd-api | 网页托管：复用判定排除已过期链接，杜绝"新建分享复活旧过期 token、持旧 URL 者重获访问权"的安全隐患 |
| fix | prd-api | 网页托管：复用带密码分享时按新密码轮换（旧密码失效），不再静默丢弃用户重设的密码 |
| fix | prd-api | 网页托管：visit 便捷链不再分配可枚举数字短链 /s/{seq}，杜绝攻击者枚举数字访问从未主动分享的私有站点（P1 安全） |
| fix | prd-api | 网页托管：复用分享时同步刷新标题/描述，站点改名或传新 title/description 后不再展示陈旧元数据 |
| fix | prd-admin | 网页托管：扫码访问 QrCodeDialog 改走 resolveVisitUrl（visit 隔离池），不再扫 listSiteShares、不再把用户限期分享的有效期覆盖成永久 |
| fix | prd-admin | 网页托管：ShareDialog 创建分享补 catch + 失败 toast，网络异常/后端失败不再静默无反馈 |
| fix | prd-api | 网页托管：重传替换改为「内存校验通过后才写入稳定 siteId 前缀」，畸形/超限 zip 失败时零副作用——旧文件不被覆盖、SiteUrl 不变（既有书签/引用不 404）、无 staging 孤儿残留（P1+P2） |
| fix | prd-admin | 网页托管：卡片操作按钮 hover 显示手型光标，提示可点击 |
