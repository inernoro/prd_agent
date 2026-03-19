# prd-desktop — Tauri 2.0 桌面客户端 (Rust + React)

## 构建命令

```bash
pnpm install
pnpm tauri:dev    # Dev with hot reload (port 1420)
pnpm tauri:build  # Production bundle
pnpm lint         # ESLint
pnpm theme:scan   # Theme consistency check
```

## 图标约定

- 桌面端唯一图标源文件是 `icon.png`。
- `pnpm tauri:dev` / `pnpm tauri:build` 前会自动执行图标生成，产物写入 `src-tauri/icons/`。
- 如果怀疑图标缓存未刷新，手动执行 `pnpm tauri:icons:force`。

## 版本同步

版本号必须同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
使用 `./quick.sh version vX.Y.Z` 统一更新。
