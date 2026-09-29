FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash jevpilot
WORKDIR /app

FROM base AS test
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN chown -R jevpilot:jevpilot /app
USER jevpilot
ENV JEVPILOT_TEST_PROFILE=server-plain JEVPILOT_TEST_EXTRA_ARGS=--no-sandbox
CMD ["sh", "-c", "npm run test:unit && npm run test:integration"]

FROM base AS build
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY tsconfig*.json ./
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM base AS runtime
EXPOSE 8940
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
RUN chown -R jevpilot:jevpilot /app
USER jevpilot
ENV JEVPILOT_DISPLAY=xvfb JEVPILOT_EXTRA_ARGS=--no-sandbox JEVPILOT_BROWSER_PATH=/usr/bin/chromium
ENTRYPOINT ["tini", "--", "node", "dist/mcp/main.js"]
