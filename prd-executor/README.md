# PRD Executor

轻量级命令执行器，支持队列调度。

## Quick Start

### 方式一：本地开发（最简单）

```bash
cd prd-executor
npm install
npm run dev
```

打开浏览器访问: http://localhost:3940

### 方式二：使用快速启动脚本

```bash
# 开发模式（本地运行，无需 Docker）
./scripts/quickstart-publish.sh dev

# Docker 模式（包含 Redis + MongoDB）
./scripts/quickstart-publish.sh docker
```

### 方式三：Docker Compose（完整栈）

```bash
# 从项目根目录
docker-compose -f docker-compose.publish.yml up -d

# 查看日志
docker-compose -f docker-compose.publish.yml logs -f executor
```

## 测试控制台

启动后访问 http://localhost:3940 可看到测试控制台界面：

- **预设命令**：Echo Test, Sleep, List Files, Error Test 等
- **自定义命令**：填写 command, args, env 等参数
- **实时输出**：查看命令执行的 stdout/stderr
- **任务管理**：查看历史任务，取消运行中的任务
- **配置管理**：动态调整并发数

## 配置

复制 `.env.example` 为 `.env` 并按需修改：

```bash
cp .env.example .env
```

### 核心配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_PORT` | 3940 | HTTP API 端口 |
| `API_HOST` | 0.0.0.0 | 监听地址 |
| `CONCURRENCY_MAX` | 3 | 最大并发数 |
| `EXECUTION_TIMEOUT` | 300000 | 默认超时（ms） |

### Redis 配置（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QUEUE_ENABLED` | false | 启用队列模式 |
| `REDIS_URL` | redis://localhost:6379 | Redis 连接 |
| `QUEUE_STREAM` | prd-executor:jobs | Stream 名称 |
| `QUEUE_GROUP` | executor-group | Consumer Group |

### MongoDB 配置（可选）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MONGO_URL` | mongodb://localhost:27017 | MongoDB 连接 |
| `MONGO_DB` | prd_executor | 数据库名 |

## API 接口

### 提交任务（同步）

```bash
curl -X POST http://localhost:3940/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "command": "echo",
    "args": ["Hello World"],
    "timeout": 60000
  }'
```

响应：
```json
{
  "success": true,
  "jobId": "uuid",
  "result": {
    "success": true,
    "exitCode": 0,
    "stdout": "Hello World\n",
    "stderr": "",
    "duration": 15
  }
}
```

### 提交任务（异步）

```bash
curl -X POST http://localhost:3940/jobs/async \
  -H "Content-Type: application/json" \
  -d '{
    "command": "sleep",
    "args": ["10"],
    "callback": "http://your-server/callback"
  }'
```

### 查询任务

```bash
# 获取单个任务
curl http://localhost:3940/jobs/{jobId}

# 列出任务
curl "http://localhost:3940/jobs?limit=20&source=api"
```

### 取消任务

```bash
curl -X DELETE http://localhost:3940/jobs/{jobId}
```

### 执行器状态

```bash
curl http://localhost:3940/status
```

响应：
```json
{
  "success": true,
  "data": {
    "activeWorkers": 1,
    "queuedJobs": 0,
    "maxConcurrency": 3,
    "queue": false,
    "api": true
  }
}
```

### 更新并发数

```bash
curl -X PUT http://localhost:3940/config/concurrency \
  -H "Content-Type: application/json" \
  -d '{"max": 5}'
```

## 三种调度模式

### 1. Local 模式（默认）

直接调用 executor，不需要任何外部依赖：

```javascript
import { Executor } from 'prd-executor';

const executor = new Executor();
await executor.start();

const result = await executor.submit({
  command: 'echo',
  args: ['hello'],
});
```

### 2. HTTP 模式

通过 HTTP API 调用：

```javascript
const response = await fetch('http://localhost:3940/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    command: 'echo',
    args: ['hello'],
  }),
});
```

### 3. Redis Stream 模式

通过 Redis Stream 发布任务：

```javascript
import Redis from 'ioredis';

const redis = new Redis();

// 发布任务
await redis.xadd('prd-executor:jobs', '*',
  'job', JSON.stringify({
    jobId: 'unique-id',
    command: 'echo',
    args: ['hello'],
    callback: 'http://your-server/callback',
  })
);

// 获取失败回调的结果
const results = await redis.lrange('prd-executor:results:your-source', 0, -1);
```

## 回调机制

异步任务完成后会回调指定的 URL：

```json
{
  "jobId": "uuid",
  "success": true,
  "exitCode": 0,
  "stdout": "output",
  "stderr": "",
  "duration": 100,
  "logsFile": "/app/logs/2024/01/uuid.jsonl"
}
```

如果回调失败，结果会存储在 Redis 中供调用方获取：
- Key: `prd-executor:results:{source}`
- 类型: List

## 日志存储

### MongoDB（操作日志）

记录任务的元数据和状态变化：

```javascript
{
  jobId: "uuid",
  source: "api",
  command: "echo",
  status: "completed",
  createdAt: ISODate(),
  startedAt: ISODate(),
  completedAt: ISODate(),
  duration: 100,
  exitCode: 0
}
```

### 文件（执行日志）

大量输出存储为 JSONL 文件：

```
/app/logs/
└── 2024/
    └── 01/
        └── {jobId}.jsonl
```

每行格式：
```json
{"ts":"2024-01-01T00:00:00.000Z","type":"stdout","data":"output line"}
```

## 测试

```bash
npm test
```

## 项目结构

```
prd-executor/
├── src/
│   ├── index.js              # 主入口
│   ├── config.js             # 配置管理
│   ├── executor/
│   │   └── commandExecutor.js # 命令执行器
│   ├── scheduler/
│   │   └── workerPool.js     # 工作池
│   ├── receiver/
│   │   ├── httpReceiver.js   # HTTP API
│   │   └── streamConsumer.js # Redis Stream
│   ├── callback/
│   │   └── callbackHandler.js # 回调处理
│   └── storage/
│       ├── mongoLogger.js    # MongoDB 日志
│       └── fileLogger.js     # 文件日志
├── public/
│   └── index.html            # 测试控制台
├── test/                     # 单元测试
├── Dockerfile
├── .env.example
└── package.json
```
