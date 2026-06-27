| fix | cds | 根治 branch override 的 null 结构哨兵覆盖 baseline（sanitizeProfileOverride 在 merge/writer 双端剥 null），整类 `invalid containerPort: null` / 空镜像 `sh:latest` 部署故障一次性消失 |
| fix | cds | docker run 前增加空镜像断言：解析出的 dockerImage 为空或含未解析模板时明确报错并指出是 CDS profile 解析问题，不再误判为 Docker 镜像问题 |
