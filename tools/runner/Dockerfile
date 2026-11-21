# Build from the integrated repository root. The image ID is recorded per run.
FROM node:24.15.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv ripgrep sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/frugal
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/opencode-plugin/package.json packages/opencode-plugin/package.json
RUN npm ci --no-audit --no-fund
COPY bench/repos/minibank/pyproject.toml bench/repos/minibank/uv.lock /opt/bench-env/
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv==0.12.3 && UV_PROJECT_ENVIRONMENT=/opt/runner /opt/uv/bin/uv sync --no-managed-python --python /usr/bin/python3 --locked --project /opt/bench-env --no-install-project
ENV PATH=/opt/frugal/node_modules/.bin:/opt/runner/bin:/usr/local/bin:/usr/bin:/bin
USER node
CMD ["node", "--version"]
