# 原生资源生命周期验收

需要本地 Docker、Python3、pnpm 和已安装的 CDS 开发依赖。脚本新建仓库外的私有证据目录和8GiB文件虚拟盘，用无宿主设备、无 privileged、无网络的QEMU容器运行真正Linux/Docker/XFS。不会访问生产主机。通过后仅保留日志、驱动与manifest，停止自身容器并逐文件核验身份后回收大型可再生产物；失败则保留虚拟盘供人工诊断，目录中可能有测试租约凭据，应保持私有并在诊断结束后退役。

先准备固定基础镜像，再分别运行代表性场景：

```bash
docker pull alpine:3.21
python3 cds/scripts/resource-lifecycle-vm/run.py resources --cycles 40
python3 cds/scripts/resource-lifecycle-vm/run.py images
python3 cds/scripts/resource-lifecycle-vm/run.py backups
```

默认从此目录的公开Debian/Node配方构建虚拟机环境；企业网络可通过 `--ca-bundle` 提供只在构建期间挂载的CA。`--base-image` 仅用于明确已有兼容环境的复验，最终manifest记录实际基础镜像。首次构建和40次TCG实验可能需要较长时间，脚本每45秒报告仍在运行，结束必须有 `DRILL_COMPLETE` 和通过的manifest。

资源实验使用同一项目、固定4MiB资源和连续部署/失败/积压工作负载；保留原始逐轮物理空间和耗时，实际SIGKILL生产者，再真正断电并启动同一虚拟盘，验证嵌套Docker原生退役及保护数据摘要。镜像实验运行实际本地OCI registry、共享镜像层和停止容器，校验回收后重新拉取内容；测试审计sink是持久文件，不能替代生产Mongo后端验证。备份实验调用完整原生worker，测试文件/父目录挂载、计划后新停止容器、真实Docker查询失败及打开FD。

每轮文件系统净可用变化是收益判据，包含其他写入。40次收敛、加速租约和静态兼容窗口均不能冒充长期生产观察。数据损坏、业务迁移及全宿主吞吐仍须按具体环境独立验收。
