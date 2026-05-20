import os
from dataclasses import dataclass

from .profiles import resolve_profile
from .schemas import SidecarEvent, SidecarRunRequest


@dataclass(frozen=True)
class UpstreamResolution:
    base_url: str | None
    api_key: str | None
    source: str

    @property
    def base_url_configured(self) -> bool:
        return bool(self.base_url)

    @property
    def api_key_configured(self) -> bool:
        return bool(self.api_key)

    def to_sdk_env(self, timeout_seconds: int) -> dict[str, str]:
        if not self.api_key:
            raise ValueError("api_key is required before building SDK env")

        env = {
            "API_TIMEOUT_MS": str(max(1, timeout_seconds) * 1000),
            "CLAUDE_CODE_MAX_RETRIES": os.environ.get("CLAUDE_CODE_MAX_RETRIES", "2"),
            "ANTHROPIC_API_KEY": self.api_key,
        }
        if self.base_url:
            env["ANTHROPIC_BASE_URL"] = self.base_url
        return env


def resolve_upstream(req: SidecarRunRequest) -> UpstreamResolution:
    if req.profile:
        prof = resolve_profile(req.profile)
        if prof is None:
            raise RuntimeError(f"profile not found: {req.profile}")
        return UpstreamResolution(prof.base_url, prof.api_key, f"profile:{req.profile}")

    if req.base_url or req.api_key:
        return UpstreamResolution(req.base_url, req.api_key, "request-override")

    env_base_url = os.environ.get("ANTHROPIC_BASE_URL", "").strip() or None
    env_api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    return UpstreamResolution(env_base_url, env_api_key, "env-default")


def provider_key_missing_event(resolution: UpstreamResolution) -> SidecarEvent:
    provider_key_mode = os.environ.get(
        "SIDECAR_PROVIDER_KEY_MODE",
        "runtime-profile-or-env",
    ).strip().lower()
    return SidecarEvent(
        type="error",
        error_code="provider_key_missing",
        message=(
            "ANTHROPIC_API_KEY is required, or MAP must provide a runtime "
            "profile/request apiKey for the official Claude Agent SDK adapter."
        ),
        content={
            "adapter": "claude-agent-sdk",
            "upstreamSource": resolution.source,
            "baseUrlConfigured": resolution.base_url_configured,
            "apiKeyConfigured": False,
            "providerKeyMode": provider_key_mode,
            "nextActions": [
                "set ANTHROPIC_API_KEY on the sidecar environment for standalone use",
                "select or create a MAP runtime profile with a valid provider apiKey",
                "verify the CDS Agent session request includes the intended runtime profile",
            ],
        },
    )
