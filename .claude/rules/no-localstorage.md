# 禁止使用 localStorage

前端项目（`prd-admin`、`prd-desktop`）禁止使用 `localStorage`，统一使用 `sessionStorage`。

## 规则

1. 所有客户端存储必须使用 `sessionStorage`，禁止 `localStorage`
2. Zustand persist store 必须配置 `storage: createJSONStorage(() => sessionStorage)`
3. 直接读写存储时使用 `sessionStorage.getItem()` / `sessionStorage.setItem()`

## 原因

- `localStorage` 在浏览器关闭后仍然保留，部署新版本后用户不刷新会使用旧缓存（菜单、权限、token）
- `sessionStorage` 随浏览器标签页关闭自动清空，每次重新打开都获取最新数据
- 杜绝用户串数据、菜单缓存不更新等部署后遗症
