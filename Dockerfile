FROM docker.io/oven/bun:1.3.2-alpine

WORKDIR /app

RUN apk add --no-cache libc6-compat gcompat rust cargo \
	&& addgroup -S app \
	&& adduser -S -G app app

COPY --chown=app:app package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY --chown=app:app . .

RUN cargo build --manifest-path /app/cmd_proxy/Cargo.toml --release \
	&& bun scripts/install-plugins.mjs \
	&& chown app:app /app \
  && chmod +x /app/cli.mjs \
	&& install -m 755 /app/cmd_proxy/target/release/cmd_proxy /usr/local/bin/cmd_proxy \
	&& ln -sf /usr/local/bin/cmd_proxy /usr/local/bin/jira \
	&& ln -sf /app/cli.mjs /usr/local/bin/subd

USER app

STOPSIGNAL SIGQUIT

CMD ["subd"]
