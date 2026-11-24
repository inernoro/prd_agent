FROM busybox:1.37.0
ARG CDS_COMMIT_SHA
LABEL org.opencontainers.image.title="CDS isolated batch acceptance site"
LABEL org.opencontainers.image.source="https://github.com/inernoro/prd_agent"
LABEL org.opencontainers.image.revision="$CDS_COMMIT_SHA"
COPY build-site.sh payload.html /tmp/cds-batch-source/
RUN sh /tmp/cds-batch-source/build-site.sh /www
USER 65534:65534
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
