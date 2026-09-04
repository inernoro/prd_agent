FROM ghcr.io/nexu-io/od:0.21.1

USER root

RUN npm install --global --ignore-scripts=false opencode-ai@1.18.28 \
    && opencode --version \
    && npm cache clean --force

USER open-design
