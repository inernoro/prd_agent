# Quickstart 零摩擦原则（Quickstart Zero-Friction）

> **核心口号**：**快启动必须大包大揽，使用者是小白。**

任何系统的 "第一次启动" 路径必须假设使用者是**完全不懂技术的人**——不知道什么是 Docker，不知道要开哪个端口，不知道为什么报"command not found"。我们不能让他在第一步就被环境问题挡住。

## 强制规则

### 规则 1：一条命令启动，其余自动化

用户记住的**唯一命令**应该是 `./quick.sh` / `./exec_cds.sh init` / `.\quick.ps1` 之类的"入口"。这条命令内部应该**主动检测 + 主动修复**所有能自动化的前置条件。

**禁止**：
- ❌ "请先安装 Node.js"（然后退出）
- ❌ "缺少 pnpm，请自行安装"（然后退出）
- ❌ 在 README 里列 15 条准备工作让用户自己做

**必须**：
- ✅ 检测 Node.js → 缺失时交互式询问"是否安装？[Y/n]" → 用户回车 → 自动装
- ✅ 检测 pnpm → 同上
- ✅ 检测所有必要工具链，逐项闭环

### 规则 2：不能自动安装的，给**具体到复制粘贴**的修复命令

某些依赖无法安全自动安装（Docker 需要 sudo + systemd + 用户组、数据库服务需要 root 配置）。这种场景必须提供**直接复制粘贴就能跑的命令**，**不能**只说"请安装 XXX"。

**禁止**：
- ❌ "Please install Docker"
- ❌ "Refer to the official Docker docs"

**必须**：
- ✅ 检测发行版：`cat /etc/os-release`
- ✅ 对 Ubuntu/Debian：`curl -fsSL https://get.docker.com | sh`
- ✅ 对 CentOS/RHEL：`yum install -y docker && systemctl start docker`
- ✅ 对 macOS：`brew install --cask docker`
- ✅ 装完后的后续步骤：`sudo usermod -aG docker $USER && newgrp docker`
- ✅ 验证命令：`docker ps` 应该不报错

### 规则 3：检测输出必须"给小白看懂"

每一项检测的输出必须包含**三要素**：

```
[检查] {依赖名}          {状态图标} {当前值}
  用途: {一句话说这东西干啥用的}
  缺失后果: {不装会出什么错}
  {如果缺失} 推荐命令: {可复制粘贴的命令}
```

**反面案例**：

```
❌ check_deps: command not found: pnpm
```

**正面案例**：

```
✅ [检查] pnpm                    ❌ 未安装
     用途: 管理前端项目的 npm 包（代替 npm）
     缺失后果: 前端代码无法编译，Dashboard 打不开
     推荐命令: npm install -g pnpm
     自动执行? [Y/n]:
```

### 规则 4：权限问题主动提示，不让用户猜

涉及 sudo、systemd、用户组、文件权限的场景，脚本**检测到权限不足时**必须告知：

1. 当前为什么失败（"当前用户不在 docker 组"）
2. 需要执行什么（`sudo usermod -aG docker $USER && newgrp docker`）
3. 执行完是否需要重新登录 / 重启（"可能需要退出 shell 再进一次"）

**禁止**默认一句 `Permission denied` 让用户自己去 Google。

### 规则 5：失败后给"下一步"，不给"回滚"

任何前置依赖安装失败（如 `apt-get install` 网络超时）时，必须给三件事：

1. **错误原因**（人类可读，不是 stderr 全文）
2. **重试命令**（加了 `-v` / 指定了镜像源 / 加了 sudo 的改良版）
3. **手动备用方案**（如果重试还不行，链接到官方安装文档）

**禁止**：
- ❌ "Installation failed. Exiting."
- ❌ "Please try again later."

### 规则 6：中文 UI + 静默成功 + 吵闹失败

- **成功的检测项**：一行简短输出（带 ✅ 绿勾），不刷屏
- **失败的检测项**：多行详细说明（带 ❌ 红叉 + 修复路径）
- **装载中**：进度提示，不能超过 3 秒没反馈

### 规则 7：init 必须幂等

跑两次、三次、跑到一半 Ctrl+C 再跑，都必须能继续往下走。已经装好的依赖跳过，已经写好的配置文件保持不变，已经创建的目录不重新创建。

**禁止**：
- ❌ 第一次跑失败，第二次跑说"配置文件已存在，请手动删除"

**必须**：
- ✅ 第二次跑自动检测当前状态，从断点继续

## 判断清单

给任何 "从零到能跑" 的入口脚本做 review 时，按这张表打勾：

| 检查项 | 状态 |
|---|---|
| 是否假设用户已装好所有依赖？ | ❌ 违规 |
| 是否检测所有能检测的依赖？ | ✅ 合规 |
| 是否自动安装能自动安装的？ | ✅ 合规 |
| 不能自动的是否给具体命令？ | ✅ 合规 |
| 错误输出是否包含"下一步怎么办"？ | ✅ 合规 |
| 跑两次能不能继续？ | ✅ 合规 |
| 中文输出？（中文环境项目）| ✅ 合规 |

## 反面案例档案

### 案例 A：`npm start` 就应该能跑

**反面**：
```bash
$ npm start
sh: next: command not found
```

**正面**：
```bash
$ npm start
Checking dependencies...
  ✅ Node.js v20.11.1
  ❌ dependencies not installed
  Installing... (npm ci)
  ✅ 145 packages installed
Starting dev server on http://localhost:3000...
```

### 案例 B：`./exec_cds.sh init` 应该大包大揽

**反面**（本项目改造前的行为）：
```
$ ./exec_cds.sh start
[ERR] 未安装 node (需要 >= 20)
[ERR] 未安装 pnpm (npm i -g pnpm)
[ERR] 未安装 docker
```

**正面**（本原则要求）：
```
$ ./exec_cds.sh init

  依赖检查与安装
  ═══════════════════════════════

  ✅ Node.js v20.11.1
  ❌ pnpm 未安装
     用途: 前端包管理器
     是否自动安装 (npm install -g pnpm)? [Y/n]: y
     ✅ pnpm v9.15.0 安装完成
  ❌ Docker 未安装 (需手动安装)
     在 Ubuntu 执行: curl -fsSL https://get.docker.com | sh
     在 macOS 执行: brew install --cask docker
     装完后再跑 ./exec_cds.sh init
  ...
```

### 案例 C：数据库连接失败时

**反面**：
```
Connection refused
Error: ECONNREFUSED 127.0.0.1:27017
```

**正面**：
```
❌ 无法连接 MongoDB (127.0.0.1:27017)

  可能原因:
    1. MongoDB 未启动 → sudo systemctl start mongod
    2. 端口被防火墙拦截 → sudo ufw allow 27017
    3. 地址错了 → 检查 .cds.env 的 MONGODB_HOST

  快速修复:
    docker run -d --name mongo -p 27017:27017 mongo:7

  如果以上都不行: 贴完整错误给开发者，或看 doc/guide.cds-env.md
```

## 与其他原则的关系

- **零摩擦输入原则**（`zero-friction-input.md`）：针对 UI 层，让用户不面对空白输入框
- **引导性原则**（`guided-exploration.md`）：针对陌生页面，让用户 3 秒知道做什么
- **本原则（Quickstart Zero-Friction）**：针对**第一次启动**，让用户在"跑起来"这步就不被环境挡住

三者共同目标：**任何时候用户都不应该盯着屏幕发呆或去 Google 搜报错**。

## 为什么这条原则必须强制

- 小白用户 80% 会在"装依赖"这一步放弃
- 开发者写代码时觉得"这谁不会"，但用户真的不会
- README 里的"环境要求"章节基本没人看
- 一个命令搞定 = 成功推广；15 条前置准备 = 项目死亡

**本项目约束**：任何以 `init` / `quick` / `start` / `bootstrap` 命名的入口脚本，代码 review 时必须对照本规则过一遍。违规的必须修改。

## 应用范围（glob）

此规则应用于所有 "首次启动 / 快速开始 / 一键部署" 类脚本：

- `exec_cds.sh` / `quick.sh` / `quick.ps1`
- `scripts/install.sh` / `scripts/setup.sh` / `scripts/bootstrap.sh`
- `Dockerfile` 中的 `ENTRYPOINT` 脚本
- 任何标榜"零配置"、"一键"、"快速开始"的脚本

不应用于：
- 开发者日常 `pnpm dev` / `dotnet run`（假设开发环境已就绪）
- CI/CD 脚本（假设构建环境由 runner 定义）
