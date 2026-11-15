# 原生资源生命周期验收

需要本地 Docker、Python3、pnpm 和已安装的 CDS 开发依赖。脚本新建仓库外的私有证据目录和8GiB文件虚拟盘，用无宿主设备、无 privileged、无网络的QEMU容器运行真正Linux/Docker/XFS。不会访问生产主机。驱动成功或失败后均只保留有界日志、源文件、驱动与manifest，停止自身容器并逐文件核验出生时记录的身份后回收大型合成产物；身份变化时保留并记录原因。目录中可能有测试租约凭据，应保持私有。驱动自包含打包，虚拟机不依赖宿主node_modules。

使用`--exercise-driver-failure`可在合成驱动启动前主动失败，检验失败路径也退役这轮虚拟盘和引导产物；此模式预期非零退出，必须另外核对manifest中失败状态、各项产物结果及自身容器已不存在，不能把预期失败当成业务测试通过。备份模式额外携带并退役Redis镜像归档，共六项大型产物。

先准备固定基础镜像，再分别运行代表性场景：

```bash
docker pull alpine:3.21
docker pull redis:7-alpine
python3 cds/scripts/resource-lifecycle-vm/run.py resources --cycles 40
python3 cds/scripts/resource-lifecycle-vm/run.py images
python3 cds/scripts/resource-lifecycle-vm/run.py backups
```

默认从此目录的公开Debian/Node配方构建虚拟机环境；企业网络可通过 `--ca-bundle` 提供只在构建期间挂载的CA。`--base-image` 仅用于明确已有兼容环境的复验，最终manifest记录实际基础镜像。首次构建和40次TCG实验可能需要较长时间，脚本每45秒报告仍在运行，结束必须有 `DRILL_COMPLETE` 和通过的manifest。

资源实验使用同一项目、固定4MiB资源和连续部署/失败/积压工作负载；保留原始逐轮物理空间和耗时，实际SIGKILL生产者，再真正断电并启动同一虚拟盘，验证嵌套Docker原生退役及保护数据摘要。镜像实验运行实际本地OCI registry、共享镜像层和停止容器，校验回收后重新拉取内容；测试审计sink是持久文件，不能替代生产Mongo后端验证。备份实验调用完整原生worker，测试文件/父目录挂载、计划后新停止容器、真实Docker查询失败及打开FD；实际Redis验证自动导出与停机后恢复前快照保留登记inode，再转正、登记并在独立实例核对64条原记录和恢复前新增记录。恢复前来源仍按既有未确认规则保护，不补造所有者来源证明；独立恢复保持每任务原256MiB预算。

每轮文件系统净可用变化是收益判据，包含其他写入。40次收敛、加速租约和静态兼容窗口均不能冒充长期生产观察。数据损坏、业务迁移及全宿主吞吐仍须按具体环境独立验收。
