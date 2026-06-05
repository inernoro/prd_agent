-- Runs once on first Postgres startup (mounted at
-- /docker-entrypoint-initdb.d/init.sql). Creates the items table the admin
-- backend reads/writes, and seeds a few rows so the dashboard table is not
-- empty on first load.

CREATE TABLE IF NOT EXISTS items (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(128) NOT NULL,
  status     VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO items (name, status)
SELECT v.name, v.status
FROM (VALUES
  ('订单服务', 'active'),
  ('用户中心', 'active'),
  ('账单网关', 'paused'),
  ('数据看板', 'active')
) AS v(name, status)
WHERE NOT EXISTS (SELECT 1 FROM items);
