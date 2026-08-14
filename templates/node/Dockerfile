FROM agent-sandbox-base:latest

RUN apk add --no-cache npm \
    && npm install -g pnpm

LABEL template.name="node" \
      template.displayName="Node.js 22" \
      template.tools="node,npm,pnpm,sh"
