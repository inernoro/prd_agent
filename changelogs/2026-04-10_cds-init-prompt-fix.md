| fix | cds | exec_cds.sh init 交互式 prompt 修复：read_default / read_secret 的 printf 被 $() 命令替换捕获导致脚本假死，改为 >/dev/tty 输出提示、</dev/tty 读取输入 |
