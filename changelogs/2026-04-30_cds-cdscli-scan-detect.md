| feat | cds-skill | `cdscli scan` 升级为四级优先识别:仓库根 cds-compose.yml 直读(SSOT)→ docker-compose.*.yml 解析(PyYAML 优先,正则降级,自动分 infra/app)→ monorepo 子目录扫描(node/dotnet/go/rust/python)→ 骨架兜底。从前的"骨架级 80% 要手改"升级到"装 CDS 前先 scan,大多数项目直接可用" |
| fix | cds-skill | 正则版 docker-compose 解析的 ports 字段去引号顺序错位,补 lstrip 在 strip quote 之前 |
| fix | cds-skill | path-prefix 标签的 TODO 注释从 quoted string 内挪到注释行(yaml 语法正确性) |
