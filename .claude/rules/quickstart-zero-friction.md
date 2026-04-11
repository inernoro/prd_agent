# 快速启动零摩擦原则（Quickstart Zero-Friction）

> **核心主张**：任何系统的快速启动必须**大包大揽**。假设使用者是一个从没见过这个项目的小白——他只知道"跑一条命令能让系统启动"。

---

## 一句话定义

> **用户执行的唯一命令永远是 `./exec_xxx.sh init`（或等价物）。它负责把所有"从零到能跑"的准备工作一把包揽——检查依赖、交互式安装缺失项、生成配置、启动服务。禁止让用户手忙脚乱地"先装 A，再装 B，再改 C，再启动"。**

---

## 强制规则

### 1. 唯一入口原则

每个可独立启动的子系统（`cds/`、`prd-api/`、`prd-admin/`、`prd-desktop/`）必须提供**唯一**的启动入口脚本，脚本名一律为 `exec_*.sh` 或 `quickstart.sh`。禁止让用户读 README 才能知道要跑哪几条命令。

### 2. 依赖自动检查 + 交互式安装

入口脚本的 `init` / `start` / `setup` 子命令必须包含依赖检查阶段，每一项依赖：

- **✅ 已安装**：打印版本号，继续
- **❌ 未安装**：
  1. 先问用户 `[Y/n]` 是否允许自动安装
  2. 用户同意 → 尝试最标准的安装命令（见下方表格）
  3. 安装成功 → 继续
  4. 安装失败 → 打印**平台特定的手工安装命令**（Ubuntu/CentOS/Mac 至少三种），让用户 copy-paste 一条命令即可，不要给模糊的 "请安装 X" 提示
- **禁止**：报错后直接 `exit 1` 让用户自己去 Google

### 3. 禁止"先设置 A 再启动 B"

如果 B 的启动依赖 A 已经跑起来（如 nginx 依赖 CDS 已在 9900 端口监听），脚本必须**自己处理依赖顺序**，不要让用户分两步执行。

反例 ❌：
```
./exec_cds.sh build
./exec_cds.sh nginx-render
./exec_cds.sh start
```

正例 ✅：
```
./exec_cds.sh start   # 一条命令包办 build + nginx + start
```

### 4. 配置文件缺失时主动 init

任何命令检测到 `.cds.env` / `config.json` / `.env` 缺失时，**主动建议跑 `init`**，不要让用户猜测。更进一步：可以直接内联调用 init 流程，让用户在当前命令里一次性走完配置。

反例 ❌：
```
$ ./exec_cds.sh start
ERROR: CDS_ROOT_DOMAINS not configured
```

正例 ✅：
```
$ ./exec_cds.sh start
[INFO] 未找到 .cds.env，是否立即进入初始化向导? [Y/n]: Y
[INFO] 进入 init 流程 ...
(完整的交互式配置)
[OK] 初始化完成，继续启动 ...
```

### 5. 交互信息必须清晰友好

每条 `[询问]` 必须同时告诉用户：
- **会做什么**：例如"将使用 `npm install -g pnpm` 安装 pnpm 包管理器"
- **为什么需要**：例如"CDS 前端构建依赖 pnpm"
- **默认选项**：`[Y/n]` 意味着回车默认 Y；`[y/N]` 默认 N

禁止只给 `[Y/n]` 不说明在问什么。

### 6. 失败不留悬案

任何安装/检查失败必须提供三件事：

1. **明确的错误原因**（不是"发生了错误"）
2. **针对当前平台的修复命令**（检测 OS，给对应的 apt/yum/brew 命令）
3. **兜底说明**：所有方法都失败时，文档链接或 issue 地址

### 7. 友好的操作反馈

长操作（tsc 编译、npm install、docker pull）必须有进度反馈，符合 `CLAUDE.md §6 禁止空白等待`：

- 超过 3 秒的操作必须显示进度（`[INFO] 正在编译 TypeScript...`）
- 超过 10 秒的操作必须有阶段性反馈（`[INFO]   已完成 3/5 ...`）
- 阻塞操作失败时立即打印错误，不要沉默超时

### 8. 最小依赖清单必须明确

入口脚本顶部必须有注释列出所有依赖，让读脚本的人也能在 5 秒内看完：

```bash
# 依赖清单（init 会自动检查并尝试安装）:
#   - Node.js >= 20     [自动: nvm / nodesource]
#   - pnpm              [自动: npm install -g pnpm]
#   - Docker            [手动: 平台相关，给 Ubuntu/CentOS/Mac 命令]
#   - openssl           [自动: apt/yum/brew]
#   - curl              [自动: apt/yum/brew]
#   - python3           [自动: apt/yum/brew]
```

---

## 标准依赖自动安装表

实施脚本时参照这张表。"自动安装"指可以在脚本里直接执行；"手动提示"指需要系统级权限或复杂流程，由脚本打印命令让用户 copy-paste。

| 依赖 | 自动/手动 | 命令 | 备注 |
|---|---|---|---|
| Node.js ≥ 20 | 半自动 | Debian/Ubuntu: `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt-get install -y nodejs`<br>Mac: `brew install node@20`<br>或推荐：`curl -fsSL https://install.nvm.sh \| bash && nvm install 20` | 涉及 sudo，需用户确认 |
| pnpm | 自动 | `npm install -g pnpm` 或 `corepack enable pnpm` | Node 装好后可直接装 |
| Docker | **手动提示** | Ubuntu: `curl -fsSL https://get.docker.com \| sh && sudo usermod -aG docker $USER`<br>CentOS: 同上<br>Mac: `brew install --cask docker` | 需要 systemd + 用户组，**不要自动装**，打印命令让用户手动 |
| openssl | 自动 | `apt-get install -y openssl` / `yum install -y openssl` / `brew install openssl` | 99% 系统自带 |
| curl | 自动 | `apt-get install -y curl` / `yum install -y curl` / `brew install curl` | 99% 系统自带 |
| python3 | 自动 | `apt-get install -y python3` / `yum install -y python3` / `brew install python3` | 用于美化 JSON 输出 |
| git | 手动提示 | 各平台标准包管理器 | 99% 系统自带 |

---

## 设计原则（为什么这样做）

### 小白为什么会 give up

传统开发者工具的失败模式：
1. 用户 clone 项目
2. 跑 `./start.sh` → 报错 "node not found"
3. Google "install node ubuntu" → 看到 5 个不同答案
4. 装错了版本
5. 跑 `./start.sh` → 报错 "pnpm not found"
6. Google "install pnpm" → 又 5 个答案
7. 装完跑 → 报错 "docker socket permission denied"
8. Google → 需要 `usermod -aG docker`
9. 忘了要 `newgrp docker` 或重新登录
10. **放弃**

每一次报错 + 搜索都在流失耐心。从小白的角度，正确体验是：

```
$ ./exec_cds.sh init
欢迎使用 CDS
正在检查依赖 ...
  ✅ Node.js v20.11.1
  ❌ pnpm 未安装
  我可以帮你装，只需要你点一下 Y。方式: npm install -g pnpm [Y/n]: Y
  ✅ pnpm v9.15.0
  ❌ Docker 未安装  
  我不能自动装 Docker (需要 sudo + 修改用户组)，但给你准确的命令:
    Ubuntu:  curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER
    Mac:     brew install --cask docker
  装完请重跑本命令。

或者: 我的命令都装完了，你帮我继续配置 [Y/n]: Y
  ...
```

每一个"小白会卡住"的点，都有脚本主动帮助。

### 与其他原则的关系

- 呼应 `zero-friction-input.md`：输入零摩擦（能上传不手输）。两者共同目标是**消除"用户发呆"的时刻**
- 呼应 `guided-exploration.md`：引导性原则（3 秒内知道做什么）。快启动是引导性的 CLI 版本
- 呼应 `no-rootless-tree.md`：不假定能力存在。快启动脚本通过检查依赖承认"这个系统需要什么"，不假定用户"应该已经装好了"

---

## 反面案例

### ❌ 反例 1：报错退出

```bash
check_deps() {
  command -v node >/dev/null || { echo "需要 node"; exit 1; }
  command -v pnpm >/dev/null || { echo "需要 pnpm"; exit 1; }
}
```

**问题**：
- 没告诉用户怎么装
- 没问用户要不要自动装
- 没区分半自动和手动情况

### ❌ 反例 2：README 里写"先装 A 再装 B"

```markdown
# 使用前提
1. 安装 Node 20+
2. 安装 pnpm
3. 安装 Docker
4. 配置 .env 文件
5. 运行 ./start.sh
```

**问题**：
- 前 4 步是用户负担
- 每一步都可能出错无反馈
- 违背"唯一入口"原则

### ❌ 反例 3：一次只报一个错

```bash
check_node || exit 1     # 用户装完 node
check_pnpm || exit 1     # 再来一次发现缺 pnpm
check_docker || exit 1   # 再来一次发现缺 docker
```

**问题**：用户要跑 3 次脚本才知道总共缺几样。应该**一次性扫描所有依赖**，然后**批量处理**。

---

## ✅ 正面示范

参见 `cds/exec_cds.sh` 的 `check_deps()` + `init` 实现（本原则落地的首个范例）。

---

## 触发条件

本原则适用于：

- 任何新增的可独立启动的子系统
- 任何对现有启动脚本的重构
- 任何 `README.md` 或 `doc/guide.quickstart.md` 的编写

**不适用于**：
- 内部工具脚本（开发者专用）
- 一次性迁移/修复脚本（运行一次就废弃）
