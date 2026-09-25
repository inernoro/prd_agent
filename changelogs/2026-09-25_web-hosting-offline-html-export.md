| feat | prd-api | 新增网页托管离线 HTML 导出：站内样式、脚本、图片、字体内嵌成单个文件，站内按编辑权、分享按原有分享门禁放行，缺失资源经响应头上报 |
| feat | prd-admin | 工作台线上版新增「下载离线 HTML」，分享页「下载源文件」改为下载离线版网页（多文件站不再只有入口一份），打包中显示秒数进度 |
| docs | doc | 网页托管债务台账补离线 HTML 导出的已知边界 |
| fix | prd-api | 离线 HTML 导出改为保留外链脚本与样式表的原元素和全部属性（地址换成 data: URL），输出带 UTF-8 BOM，页面自带内容安全策略时拒绝导出并说明下一步 |
| fix | prd-api | 离线 HTML 导出统计仍依赖外部网络的地址并经响应头返回，引用片段接回 data: URL，遵循页面第一个 base href，预加载与样式表、脚本共用内嵌路径 |
| fix | prd-admin | 离线 HTML 下载结论在仍有外部依赖时不再宣称断网可打开，改为说明几处依赖外部网络及来源主机 |
| fix | prd-api | 离线导出只内嵌会被浏览器取回的 link（rel 白名单），canonical / alternate 等元数据链接不再被误报缺失或计入外部依赖 |
| fix | prd-api | 离线导出把协议相对地址（//cdn…）补成 https:，下载的文件联网时外部资源可正常加载 |
| fix | prd-api | 离线导出把协议相对的 base 地址也补成 https: |
| fix | prd-api | 离线导出带 layer/supports 的站外导入计入外部依赖；缺失与外部依赖诊断头逐条截断、总长设上限 |
| fix | prd-admin | 「下载离线 HTML」按钮提示不再预先承诺断网可打开 |
