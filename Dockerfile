FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node src ./src
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV PORT=3000 CONFIG_FILE=/app/config.json STATE_FILE=/app/data/state.json
EXPOSE 3000
CMD ["node", "src/index.mjs", "serve"]
