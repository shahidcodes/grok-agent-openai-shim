FROM oven/bun:1.2-alpine

WORKDIR /app

COPY proxy.ts package.json ./

RUN bun install --production

EXPOSE 12300

ENV PORT=12300
ENV TARGET_HOST=api.fireworks.ai
ENV TARGET_PATH=/inference

CMD ["bun", "run", "proxy.ts"]
