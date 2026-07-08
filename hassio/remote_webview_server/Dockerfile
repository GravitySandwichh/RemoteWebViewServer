# Home Assistant builds this add-on using ONLY this folder as the Docker
# build context (not the whole repo), so it can't COPY src/package.json from
# the repo root. Previously this Dockerfile just `FROM`'d a prebuilt image
# published to the *upstream* strange-v Docker Hub account, which meant every
# code change in this fork's src/ was silently never deployed no matter how
# often the add-on was "updated". Clone this fork's source during the build
# instead, so the add-on always reflects what's actually on REPO_REF.
ARG REPO_URL=https://github.com/GravitySandwichh/RemoteWebViewServer.git
ARG REPO_REF=main

FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS build
ARG REPO_URL
ARG REPO_REF
# Supervisor passes BUILD_VERSION matching this add-on's config.yaml
# "version:" on every build. Referencing it here busts Docker's layer cache
# for the clone step each time the version is bumped — without this, Docker
# would happily reuse a stale cached clone from a previous build and a
# version bump alone wouldn't actually fetch new code.
ARG BUILD_VERSION=dev
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN echo "add-on version ${BUILD_VERSION}: cloning ${REPO_URL}#${REPO_REF}" \
 && git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" .
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.55.0-jammy AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq socat ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/self-test ./self-test
COPY --from=build /src/package.json ./package.json
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8081 18080 9221

CMD ["/run.sh"]
