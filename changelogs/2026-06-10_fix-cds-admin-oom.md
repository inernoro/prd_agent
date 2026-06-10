| fix | prd-admin | vite build 关 sourcemap、esbuild minify 降低 CDS static 部署 OOM 风险 |
| fix | cds-compose | admin 构建增加 NODE_OPTIONS=--max-old-space-size=4096 |
| fix | prd-admin | CDS 构建检测 VITE_BUILD_ID：关 minify、限 rollup 并行；新增 cds-vite-build.sh |
| fix | cds-compose | admin 默认改 dev(Vite HMR) 秒级就绪；static 走 scripts/cds-vite-build.sh |
