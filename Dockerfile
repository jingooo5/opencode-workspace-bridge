# Runtime image for testing the local opencode-context-bridge plugin
FROM ubuntu:latest

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends bash curl ca-certificates unzip git vim \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /root/app
COPY . /root/app/

RUN bun install
RUN bun run build

RUN curl -fsSL https://opencode.ai/install | bash

CMD ["tail", "-f", "/dev/null"]