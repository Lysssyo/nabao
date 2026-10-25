FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm test && mkdir -p /app/data /app/public /app/status && chown -R node:node /app/data /app/public /app/status
USER node
ENV NABAO_DATA_DIR=/app/data
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["doctor"]
