| feat | cds | 分支入口卡新增「配置入口」按钮，用户可手动加/改多出口（域名前缀 → 服务端口 + 入口名称 + 落地路径），地址即时预览，可保存到项目或仅本分支 |
| feat | cds | 新增 GET/PUT /api/branches/:id/web-entry-config：扫描本分支服务端口与当前入口来源，写回 BuildProfile（项目档）或 profileOverrides（分支档），保存后由 forwarder 秒级重发路由，无需重新部署 |
| feat | cds | BuildProfileOverride 支持 subdomain / webEntry 覆盖，分支可以取消或改写项目底座声明的命名入口 |
| refactor | cds | 「有没有给人看的入口」收敛成唯一判据 resolveWebEntry（名称为空即无入口），入口清单与手动配置共用一份，避免两处漂移 |
| polish | cds | 入口配置弹窗：子域非法时不再把拼不出去的 host 渲染成可点链接，改为提示「子域不合法，改好后这里显示地址」 |
| fix | cds | 入口配置：API-only 服务（有子域无入口名）不再被拒；此前会逼用户编个名字，删行则静默清掉它已有的命名路由 |
| fix | cds | 入口配置：保存不再丢 webEntry.primary，一次改名不会把主入口连同主域名 URL 挪到别的服务 |
| fix | cds | 入口配置：存项目档时逐条校验会继承该值的分支，别的分支撞车不再放行成「保存成功但地址打不开」 |
| fix | cds | 入口配置：本分支自己的子域别名/自定义域名占位同样判冲突（发布器不跳过自己，放行等于存一条发不出的路由） |
| fix | cds | 入口配置：托管交付项目拒绝写项目档（清单由方案生成会被覆盖），项目档写入改从目标项目的 profile 表解析，杜绝同名 id 误写别的项目 |
| fix | cds | 入口配置撞车判定改用 publishedServiceLabels（含历史别名）枚举 host，llmgw 与 llmgw-web 这类展开后重合的子域不再被放行；豁免收窄到本服务自己当前发布的 host |
| fix | cds | 入口配置弹窗丢弃迟到的扫描响应（代次 + branchId 双判），避免快速切换分支时用 A 的配置覆盖 B |
