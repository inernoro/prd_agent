| fix | cds | install-forwarder 注入 nvm/asdf 的 node bin 路径到 systemd PATH(原默认 PATH 找不到 nvm 装的 node,forwarder 启动 status=127/n/a 拒启) |
| fix | cds | install-forwarder 三层探测 node 路径(sudo 下 `command -v node` 找不到 nvm 时,fallback 到 master service 的 PATH 与 /root/.nvm 标准位置) |
