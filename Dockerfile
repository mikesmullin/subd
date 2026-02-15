FROM docker.io/oven/bun:1.3.2-alpine

WORKDIR /app

RUN apk add --no-cache libc6-compat gcompat \
	&& addgroup -S app \
	&& adduser -S -G app app

COPY --chown=app:app package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY --chown=app:app . .

RUN bun scripts/install-plugins.mjs \
	&& chown app:app /app \
  && chmod +x /app/cli.mjs \
	&& ln -sf /app/cli.mjs /usr/local/bin/subd

USER app

CMD ["subd"]
