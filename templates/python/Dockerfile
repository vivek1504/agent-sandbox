FROM agent-sandbox-base:latest

RUN apk add --no-cache \
    python3 \
    py3-pip \
    python3-dev \
    gcc musl-dev \
    && pip install --break-system-packages poetry

LABEL template.name="python" \
      template.displayName="Python 3.12" \
      template.tools="python3,pip,poetry,sh"
