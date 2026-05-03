-- CDS MySQL Demo —— 初始化脚本
--
-- 由 docker-entrypoint-initdb.d 机制在 mysql 容器**首次启动**时自动执行
-- (data volume 已存在时不会重复执行,这是 mysql 官方 image 的固有行为)。
--
-- 本脚本演示"用户提供 init.sql"=> "通过 git repo 提交 init.sql 文件"
-- 这一约定路径,验证 CDS 4 步契约的第三步 / 第四步衔接。

-- 1) 切到目标库(由 cds-compose env MYSQL_DATABASE=app_db 创建)
USE app_db;

-- 2) 业务表:users
CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username    VARCHAR(64) NOT NULL,
  email       VARCHAR(128) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username),
  UNIQUE KEY uk_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3) 种子数据(便于 demo 一上线即看见行)
INSERT INTO users (username, email) VALUES
  ('alice',   'alice@cds.demo'),
  ('bob',     'bob@cds.demo'),
  ('charlie', 'charlie@cds.demo')
ON DUPLICATE KEY UPDATE username = VALUES(username);
