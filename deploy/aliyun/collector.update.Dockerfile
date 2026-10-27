# Reuse a verified deployed runtime only when package.json and package-lock.json
# are byte-identical. The release script must check both before building.
ARG COLLECTOR_BASE_IMAGE
FROM ${COLLECTOR_BASE_IMAGE}
COPY --chown=node:node dist/src /app/dist/src
