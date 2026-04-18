| feat | prd-api | 新增 HomepageAsset 实体与 HomepageAssetsController（admin 上传/删除）+ HomepageAssetsPublicController（任意登录用户可读），支持首页四张快捷卡背景与所有 Agent 封面图/视频的动态上传 |
| feat | prd-admin | 设置 → 资源管理新增「首页资源」Tab：4 张快捷卡背景 + 17 个 Agent 封面图/视频上传，一个 slot 一张图/视频，自动映射到 CDN |
| feat | prd-admin | LandingPage（AgentLauncherPage）读取已上传的 card 背景与 agent 封面/视频，优先覆盖默认渐变/CDN 素材 |
| feat | prd-api | HomepageAssetsController BuildObjectKey 新增 hero.{id} 路由 → 老 CDN 路径 icon/title/{id}.{ext}，首页顶部 Banner 可在设置页一键替换 |
| feat | prd-admin | 设置页资源管理「首页资源」Tab 顶部新增「首页顶部 Banner」区块，未上传显示老图 + 默认徽标 |
| feat | prd-admin | LandingPage heroBgUrl 改走 useHeroBgUrl hook（订阅 store + ?v= 缓存爆破），上传即时生效 |
