#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
case "${1:-}" in
  check)
    test -s cds-compose.yml
    test -s cds-storage-plan.json
    test -s backend/app/cds_runtime.py
    test -s frontend/nginx.cds.conf.template
    python3 -m py_compile backend/app/cds_runtime.py
    sh -n backend/cds-entrypoint.sh
    sh -n frontend/cds-auth.sh
    python3 backend/tests/test_cds_policy.py
    ;;
  deploy)
    : "${CDS_COMMIT_SHA:?Set the verified full deployment commit}"
    actual_commit=$(git rev-parse HEAD)
    [ "$actual_commit" = "$CDS_COMMIT_SHA" ] || { echo 'Deployment commit mismatch' >&2; exit 1; }
    : "${DEEPAUDIT_PUBLIC_URL:?Set the actual configured management URL}"
    command -v docker >/dev/null
    command -v curl >/dev/null
    docker compose -p deepaudit -f docker-compose.cds-release.yml config --quiet
    docker compose -p deepaudit -f docker-compose.cds-release.yml pull --quiet
    for component in backend frontend; do
      image="ghcr.io/inernoro/deepaudit-cds-${component}:sha-${CDS_COMMIT_SHA}"
      revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
      [ "$revision" = "$CDS_COMMIT_SHA" ] || { echo "Image revision mismatch: $component" >&2; exit 1; }
    done
    docker compose -p deepaudit -f docker-compose.cds-release.yml up -d postgres redis
    docker compose -p deepaudit -f docker-compose.cds-release.yml run --rm db-migrate
    docker compose -p deepaudit -f docker-compose.cds-release.yml up -d --wait backend frontend
    # This interface must challenge anonymous users. Health does not count as UI acceptance.
    status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$DEEPAUDIT_PUBLIC_URL/")
    [ "$status" = 401 ] || { echo "Management gate failed: HTTP $status" >&2; exit 1; }
    echo '服务已启动且匿名管理访问被拒绝；仍需凭据登录与页面资源验收。'
    ;;
  *) echo 'Usage: cds-release.sh check|deploy' >&2; exit 2;;
esac
