| fix | cds | 修复删除带 TCP 外部访问代理的分支后，残留 enabled 策略仍把代理名算作 active、导致孤儿收割器跳过仍公网暴露的 resource-external-access 容器（getActiveExternalAccessProxyContainerNames 增加归属分支存活校验，Codex P1） |
