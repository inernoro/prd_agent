| fix | cds | Docker address pool 耗尽时的自动回收逻辑抽成公共 helper，并覆盖项目网 / 分支网 / 资源公网 TCP proxy 等所有 `docker network create` 路径；避免只有 `cds-br-*` 分支网触发清理，`cds-proj-*` 项目网仍直接失败 |
| fix | cds | 地址池耗尽善后增加空 `cds-proj-*` 项目网回收；线上确认空项目网会占用 Docker 子网，清理后可立即恢复 network create |
