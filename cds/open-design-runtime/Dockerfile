FROM ghcr.io/nexu-io/od:0.21.1

LABEL org.opencontainers.image.source="https://github.com/nexu-io/open-design" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT" \
      org.opencontainers.image.description="CDS internal OpenDesign 0.21.1 runtime with OpenCode 1.18.28"

USER root

RUN npm install --global --ignore-scripts=false opencode-ai@1.18.28 \
    && opencode --version \
    && npm cache clean --force

COPY THIRD_PARTY_NOTICES.md /usr/share/doc/map-open-design-runtime/THIRD_PARTY_NOTICES.md

USER open-design
