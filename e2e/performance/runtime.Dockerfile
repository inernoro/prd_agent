# syntax=docker/dockerfile:1
FROM mongo:7@sha256:9896df581dfd0718b7abe112f4c37598d0986c54060e4ec1384997e6503c8c71
# Mongo's minimal Ubuntu base lacks ICU. Install it from Ubuntu's own archive;
# do not refresh or contact the Mongo package repository during this test build.
RUN apt-get -o Dir::Etc::sourceparts=- update \
    && apt-get -o Dir::Etc::sourceparts=- install -y --no-install-recommends libicu70=70.1-2 \
    && rm -rf /var/lib/apt/lists/*
