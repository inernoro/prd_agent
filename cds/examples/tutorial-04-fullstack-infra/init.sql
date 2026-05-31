CREATE TABLE IF NOT EXISTS smoke_checks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  label VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO smoke_checks (label)
SELECT 'mysql-ready'
WHERE NOT EXISTS (
  SELECT 1 FROM smoke_checks WHERE label = 'mysql-ready'
);
