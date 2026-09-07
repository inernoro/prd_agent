| security | cds | container-exec 命令改单引号传入容器 sh，宿主 shell 不再展开 `$VAR` / `$(...)`，堵住 CDS 主进程环境泄露与宿主命令注入 (#1448) |
| security | cds | 脱敏器新增 PEM 私钥整块识别（BEGIN 到 END，未闭合时到文末），printenv / cat 多行私钥体不再原样输出 (#1448) |
