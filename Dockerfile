# BiletAI server image.
#
# - No API keys in the image: .env is never copied in; the container gets its
#   environment from outside (docker-compose `env_file`, or `container.environment`).
# - data/ and logs/ are bind-mounted volumes, so user accounts, generations and
#   logs survive container rebuilds.
#
# Build:  docker build -t biletai-server .
# Run:    see docker-compose.yml

FROM node:22-slim

WORKDIR /app

# Install production dependencies first (separate layer: code changes don't
# re-run npm install as long as package.json + lockfile don't change).
COPY package.json package-lock.json ./
# Keep devDependencies: `npm run server` runs tsx (a devDependency). tsx is the
# only extra runtime piece; nothing from node_modules ever reaches the apps.
RUN npm ci

# The app, settings, client UI (served by the server itself). No .env, no data/.
COPY src/ ./src/
COPY client/ ./client/
COPY config/ ./config/

# Server state and logs live in mounted volumes.
RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production \
    PORT=8787 \
    LOG_LEVEL=info

EXPOSE 8787

# npm run server = tsx src/server/server.ts (tsx ships with the project's
# devDependencies and is kept here on purpose: no build step needed).
CMD ["npm", "run", "server"]
