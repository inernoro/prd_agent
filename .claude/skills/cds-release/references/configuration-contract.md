# CDS 发布目标配置合同

## 通用字段

```json
{
  "projectId": "example",
  "name": "Example 正式环境",
  "host": "prod.example.internal",
  "port": 22,
  "user": "deploy",
  "privateKeyRef": "example-production-host",
  "appPath": "/opt/example",
  "healthcheckUrl": "https://www.example.com/health",
  "environment": "production",
  "isCanonical": true,
  "rollbackCommand": "",
  "strategy": {}
}
```

约束：

- `projectId` 必须等于项目级 Key 的作用域。
- `privateKeyRef` 必须已经由本项目发布目标使用，或先由系统管理员预置。
- `appPath` 必须是绝对路径且不能是文件系统根。普通 SSH 目标预检时要求它是 Git 根目录，origin 规范化后等于项目绑定仓库。
- `healthcheckUrl` 必须是最终公网 HTTP/HTTPS 地址。
- 同一项目同一环境最多有一个启用的 `isCanonical=true` 目标。
- `projectIdentity` 由服务端从 Project 生成，调用方不得传入并期望覆盖。

## project-script（新目标默认）

```json
{ "mode": "project-script", "scriptFile": "cds-release.sh" }
```

文件为安全仓库相对路径；默认名 `cds-release.sh`。项目 CI 必须测试同一文件的
`check`；CDS 要求同一完整提交 CI 成功，读取 Git blob、校验 Bash 语法和正文
SHA-256，在指定提交的隔离目录先 check 再 deploy。缺脚本或失败不得换模式兜底。

## managed-script（明确选择的备选）

```json
{ "mode": "managed-script", "script": "#!/bin/bash\nset -eu\n# implement check / deploy\n" }
```

由 CDS 单独保存正文，须单独审查，不属于项目 CI 已测试正文。禁止硬编码密钥，
最大 256 KiB；同样检查语法、正文哈希和 check，再执行 deploy。

## existing-script（仅存量兼容）

```json
{
  "mode": "existing-script",
  "command": "./deploy.sh",
  "detectedFrom": ["./deploy.sh"]
}
```

`command` 必填。发布前会识别 `.sh` 路径并检查文件存在、可执行。

## generated-compose

```json
{
  "mode": "generated-compose",
  "composeFile": "compose.yml",
  "composeProject": "example-prod",
  "detectedFrom": ["compose.yml"]
}
```

- `composeFile` 必须是安全的仓库相对路径，禁止绝对路径和 `..` 越界。
- `composeProject` 只允许小写字母、数字、连字符和下划线。
- 远端必须提供 Git、Bash、base64、Python 3、Docker 与 Docker Compose。

## generated-static

```json
{
  "mode": "generated-static",
  "buildCommand": "pnpm install --frozen-lockfile && pnpm build",
  "artifactDirectory": "dist",
  "publicDirectory": "/opt/example-web",
  "detectedFrom": ["package.json", "pnpm-lock.yaml"]
}
```

- `buildCommand` 必填，必须是可复现的锁文件安装与构建命令。
- `artifactDirectory` 必须是安全的仓库相对路径。
- `publicDirectory` 必须是至少两段的非系统绝对路径；禁止 `/`、`/etc/...`、`/usr/...` 等系统目录。Web Server 根目录指向其 `current`。
- 远端必须提供 Git、Bash、base64、Python 3 与项目构建依赖。

## 服务端返回的身份快照

```json
{
  "projectIdentity": {
    "projectId": "example",
    "projectSlug": "example",
    "repository": "owner/example"
  }
}
```

后续预检先把快照与当前 Project 比较，再通过 SSH 读取 `appPath` 的 Git origin。项目被重新绑定仓库、目标被错误迁移、远端目录属于其他系统或项目缺少仓库身份时，检查为 blocking fail。
