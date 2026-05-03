/**
 * CDS MySQL Demo —— Express + MySQL2 演示应用
 *
 * 用途:验证 CDS "mysql 4 步契约":
 *   步 1  创建项目(指向本仓库 git URL)
 *   步 2  CDS clone + scan,识别出 mysql infra
 *   步 3  envMeta 三色弹窗:用户填 required(MYSQL_ROOT_PASSWORD 等),
 *         CDS 自动生成 auto(数据库名 = app_db, 来自本仓库 cds-compose 的
 *         x-cds-env 段),用户提供 init.sql(随项目 clone 进来)
 *   步 4  Deploy → mysql 容器起 + init.sql 执行 → app 容器起 + 查 users 成功
 *
 * 启动后访问 GET / 返回 users 表前 100 条。
 */

const express = require('express');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const DB_HOST = process.env.MYSQL_HOST || 'db';
const DB_PORT = parseInt(process.env.MYSQL_PORT || '3306', 10);
const DB_USER = process.env.MYSQL_USER || 'app';
const DB_PASSWORD = process.env.MYSQL_PASSWORD || '';
const DB_NAME = process.env.MYSQL_DATABASE || 'app_db';

const app = express();
app.disable('x-powered-by');

let pool;

async function getPool() {
  if (pool) return pool;
  pool = await mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
  });
  return pool;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'cds-mysql-demo' });
});

app.get('/db-info', async (_req, res) => {
  res.json({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    database: DB_NAME,
  });
});

app.get('/', async (_req, res) => {
  try {
    const p = await getPool();
    const [rows] = await p.query(
      'SELECT id, username, email, created_at FROM users ORDER BY id ASC LIMIT 100'
    );
    res.json({
      ok: true,
      database: DB_NAME,
      count: rows.length,
      users: rows,
    });
  } catch (err) {
    console.error('[cds-mysql-demo] query failed:', err.message);
    res.status(500).json({
      ok: false,
      error: err.code || 'UNKNOWN',
      message: err.message,
      database: DB_NAME,
      host: DB_HOST,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[cds-mysql-demo] listening on :${PORT} (db=${DB_NAME}@${DB_HOST}:${DB_PORT})`);
});
