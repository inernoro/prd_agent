"""CDS static-review runtime: no demo account, public registration or PoC routes."""
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from sqlalchemy import select, update

from app.api.v1.endpoints import auth, config, members, projects, prompts, rules, scan, tasks, users
from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import AsyncSessionLocal
from app.models.audit import AuditTask
from app.models.user import User


def validate_runtime_config(environ=None):
    """Fail before listening if any independent service secret is missing."""
    env = os.environ if environ is None else environ
    secret = env.get("SECRET_KEY", "")
    email = env.get("CDS_SERVICE_EMAIL", "")
    password = env.get("CDS_SERVICE_PASSWORD", "")
    if len(secret) < 32 or secret.startswith("changethis"):
        raise RuntimeError("SECRET_KEY must be an independently generated secret of at least 32 characters")
    if "@" not in email or email.lower() == "demo@example.com":
        raise RuntimeError("CDS_SERVICE_EMAIL must identify the dedicated CDS service account")
    if len(password) < 20:
        raise RuntimeError("CDS_SERVICE_PASSWORD must contain at least 20 characters")
    if not env.get("DATABASE_URL") or not env.get("LLM_API_KEY") or not env.get("LLM_MODEL"):
        raise RuntimeError("DATABASE_URL, LLM_API_KEY and LLM_MODEL are required")
    return email, password


@asynccontextmanager
async def lifespan(app):
    email, password = validate_runtime_config()
    async with AsyncSessionLocal() as db:
        # A pre-existing upstream demo account must never remain usable.
        await db.execute(update(User).where(User.email == "demo@example.com").values(is_active=False))
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is None:
            user = User(email=email, full_name="CDS 审查服务", is_active=True,
                        is_superuser=True, role="admin")
            db.add(user)
        user.hashed_password = get_password_hash(password)
        # Upstream regular scans are in-process BackgroundTasks, not durable workers.
        # Surface an interrupted scan as failed so CDS can offer an explicit retry.
        await db.execute(update(AuditTask).where(AuditTask.status.in_(["pending", "running"]))
                         .values(status="failed", completed_at=datetime.now(timezone.utc)))
        await db.commit()
        from app.services.init_templates import init_templates_and_rules
        await init_templates_and_rules(db)
    yield


app = FastAPI(title="DeepAudit CDS 静态审查", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)

# Mount only ordinary source-analysis routes. Agent/SSH/database administration
# routers are deliberately absent; unsupported environment flags are not relied on.
for prefix, router in (
    ("auth", auth.router), ("users", users.router), ("projects", projects.router),
    ("projects", members.router), ("tasks", tasks.router), ("scan", scan.router),
    ("config", config.router), ("prompts", prompts.router), ("rules", rules.router),
):
    app.include_router(router, prefix=f"{settings.API_V1_STR}/{prefix}")
app.router.routes[:] = [route for route in app.router.routes
                       if getattr(route, "path", "") != f"{settings.API_V1_STR}/auth/register"]


@app.get("/health")
async def health():
    return {"status": "ok", "runtime": "cds-static-review", "dynamicVerification": False}
