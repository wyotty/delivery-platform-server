# Playwright base image ships chromium + all system deps pinned to the same
# version as the playwright npm package — keep this tag in sync with
# package.json's playwright dependency.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    # browsers are already baked into the base image
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DB_PATH=/app/data/delivery.db

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.7.1 --activate

COPY package.json pnpm-lock.yaml ./
COPY shims/ ./shims/

RUN pnpm install --frozen-lockfile --prod=false

COPY . .

RUN pnpm run lint

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx runs the TypeScript sources directly — no build step in this project.
# Defaults to the long-running server; override the command for one-off CLI runs:
#   docker run ... <image> fetch grab grab-dong-day 2026-07-26
ENTRYPOINT ["pnpm", "run"]
CMD ["start"]
