| feat | prd-api | DocumentStore 新增 TagColors 字段（tagName→调色板 key 映射），白名单校验 8 色 |
| feat | prd-api | UpdateStore PUT 端点支持 tagColors 字段，传 null 不变、传空 dict 清空 |
| feat | prd-admin | DocBrowser 新增受控 props tagColors + onTagColorsChange：传入时全局持久化、未传时回退 sessionStorage |
| feat | prd-admin | DocumentStorePage 把 store.tagColors 接到 DocBrowser，编辑器选色后乐观更新 + PUT 落库 |
