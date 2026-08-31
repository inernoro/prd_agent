| feat | cds | 分支入口卡新增「配置入口」按钮，用户可手动加/改多出口（域名前缀 → 服务端口 + 入口名称 + 落地路径），地址即时预览，可保存到项目或仅本分支 |
| feat | cds | 新增 GET/PUT /api/branches/:id/web-entry-config：扫描本分支服务端口与当前入口来源，写回 BuildProfile（项目档）或 profileOverrides（分支档），保存后由 forwarder 秒级重发路由，无需重新部署 |
| feat | cds | BuildProfileOverride 支持 subdomain / webEntry 覆盖，分支可以取消或改写项目底座声明的命名入口 |
| refactor | cds | 「有没有给人看的入口」收敛成唯一判据 resolveWebEntry（名称为空即无入口），入口清单与手动配置共用一份，避免两处漂移 |
