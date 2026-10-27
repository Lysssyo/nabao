# Build context: package files plus verified, compiled dist/src from the same release.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
COPY dist/src ./dist/src
RUN mkdir -p /app/data /app/public /app/status \
    && chown -R node:node /app/data /app/public /app/status
USER node
ENV NABAO_DATA_DIR=/app/data
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["control"]
