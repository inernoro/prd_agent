# CDS Fullstack Infra Smoke

This fixture is a minimal full-stack project for validating the CDS one-click deploy flow.

It contains:

- `frontend`: a Vite static page that calls `/api/health`.
- `backend`: an Express API that checks MySQL, Redis, and RabbitMQ.
- `mysql`: seeded with `init.sql`.
- `redis`: used for a short-lived key check.
- `rabbitmq`: used for a queue publish/read check.

Expected CDS import result:

- BuildProfile `frontend`, path prefix `/`, port `4173`.
- BuildProfile `backend`, path prefix `/api/`, port `3000`.
- Infra services `mysql`, `redis`, `rabbitmq`.
- Project env values `MYSQL_URL`, `REDIS_URL`, `RABBITMQ_URL`.

Manual smoke path:

1. Open CDS project list.
2. Choose `从 YAML 沙盒新建`.
3. Paste `cds-compose.yml`.
4. Add `init.sql`, `frontend/package.json`, `frontend/index.html`, `frontend/src/main.js`, `backend/package.json`, and `backend/src/server.js` as extra files.
5. Create the project.
6. Open the branch and deploy.
7. Open the preview page and verify all checks are `通过`.
