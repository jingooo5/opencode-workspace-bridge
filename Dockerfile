# Final runtime image
FROM oven/bun:debian
RUN apt-get update && apt-get install -y bash curl
WORKDIR /app

COPY . /app/
RUN bun install

RUN curl -fsSL https://opencode.ai/install | bash

RUN mkdir -p /root/.config/opencode
RUN cat > /root/.config/opencode/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-context-bridge"],
}
EOF
