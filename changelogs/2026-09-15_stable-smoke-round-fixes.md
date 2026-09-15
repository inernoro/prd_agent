| fix | prd-api | 稳定冒烟巡检账号按 StableSmokeIdentityPolicy 开号并自动补齐矩阵所需权限，录音、文件、短视频、会话权限用例不再被「无权限」挡在业务动作之前 |
| test | prd-api | 新增巡检身份权限契约测试：策略覆盖矩阵触达的每个管理控制器、旧角色缺项可复现、e2e 夹具与后端一字不差 |
| fix | prd-admin | 生图进度底边行把中心点当左缘定位，0.5 倍下右缘超出画框（590.75 > 501）；换算收敛到 generationProgressMetaStyle 并补回归 |
| fix | prd-admin | 默认头像改为同源 5 KB WebP，不再每屏跨域拉对象存储上 3 MB 的 nohead.png |
| polish | prd-admin | 录音面板状态胶囊与「上传文件」兜底按钮补机读锚点（data-testid / data-state），自动化不再依赖会随稿面变化的文案 |
| fix | cds | 预览小部件在手机上 4 秒后收成 36px 圆钮并暴露 data-cds-layout，不再整条压在业务内容上 |
| test | e2e | 稳定冒烟：新增巡检身份权限预检；录音用例改用机读锚点；多图主路判据改为图片协议集合；GW-007 缺第二上游时临时挂备用上游并在结束时停用；模块入口新增图片资源失败判定；移动端新增小部件紧凑态判定 |
| test | e2e | 单图下载文件名改为断言产品写入的 download 属性（Chromium 对 blob 链接不回报建议文件名）；录音旅程先关闭 CDS 预览小部件 |
| fix | prd-api | 权限托管开关 ManagePermissions 接进三份部署文件：正式与本地默认关闭，CDS 验证环境开启，并加契约测试 |
| fix | prd-admin | 资源管理页「无头像兜底」预览改回对象存储托管图并说明用途，管理端同源轻量版不受影响 |
| fix | cds | 预览小部件同步进行中或失败时不缩成圆钮，转圈与失败态在手机上仍可见 |
| fix | prd-api | 巡检账号补权改为原子 addToSet / pullAll，不再整表覆盖并发中的管理员修改 |
| test | e2e | GW-007 清理作用域前置到启用备用上游之前、认领上一轮遗留的已启用备用、备用照抄捐出方 Offering 的路由契约 |
| fix | prd-api | 稳定冒烟账号补齐权限改为对 null 安全的聚合管道更新：存量账号 PermAllow / PermDeny 为 BSON null 时 $addToSet / $pullAll 会整条报错，补齐从未生效；新增真 Mongo 回归测试复现旧写法报错并覆盖 null / 缺失 / 已有清单三种形态 |
| fix | prd-admin | 资源管理页托管默认头像地址接受本地开发下发的 /local-assets 相对基址，绝对地址仍只认 http(s)，协议相对地址照旧拒绝 |
| test | prd-api | 稳定冒烟权限夹具增加 superPermission 并由跨语言契约测试钉住；e2e 预检与后端同口径，持有 super 视为矩阵权限齐全；模块入口图片判定补记 4xx/5xx 图片响应，SVG 改用 decode() 判碎图 |
