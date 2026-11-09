"""CDS static-review runtime: no demo account, public registration or PoC routes."""
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.endpoints import auth, config, members, projects, prompts, rules, scan, tasks, users
from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import AsyncSessionLocal, get_db
from app.models.audit import AuditTask
from app.models.user import User
from app.schemas.token import Token
from app.services.scan_errors import ERROR_MESSAGES

CDS_ADMIN_EMAIL = "cds-admin@example.com"


def validate_runtime_config(environ=None):
    """Fail before listening if any independent service secret is missing."""
    env = os.environ if environ is None else environ
    secret = env.get("SECRET_KEY", "")
    email = env.get("CDS_SERVICE_EMAIL", "")
    password = env.get("CDS_SERVICE_PASSWORD", "")
    if len(secret) < 32 or secret.startswith("changethis"):
        raise RuntimeError("SECRET_KEY must be an independently generated secret of at least 32 characters")
    if "@" not in email or email.lower() in ("demo@example.com", "cds-admin@example.com"):
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
                         .values(status="failed", completed_at=datetime.now(timezone.utc),
                                 error_code="ANALYSIS_FAILED", error_message=ERROR_MESSAGES["ANALYSIS_FAILED"]))
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
app.router.routes[:] = [route for route in app.router.routes if getattr(route, "path", "") not in {
    f"{settings.API_V1_STR}/auth/register", f"{settings.API_V1_STR}/auth/login",
}]


@app.post(f"{settings.API_V1_STR}/auth/login", response_model=Token)
async def cds_login(form_data: OAuth2PasswordRequestForm = Depends(),
                    db: AsyncSession = Depends(get_db)):
    # The human alias uses its own account; machine service emails stay unchanged.
    if form_data.username == "admin":
        form_data.username = CDS_ADMIN_EMAIL
    return await auth.login(db=db, form_data=form_data)


@app.get("/health")
async def health():
    return {"status": "ok", "runtime": "cds-static-review", "dynamicVerification": False}
