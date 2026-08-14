FROM agent-sandbox-base:latest

RUN apk add --no-cache go

ENV GOROOT=/usr/lib/go
ENV GOPATH=/workspace/go
ENV PATH=$PATH:/usr/lib/go/bin:/workspace/go/bin

RUN mkdir -p /etc/profile.d \
    && echo "export GOROOT=/usr/lib/go" >> /etc/profile.d/go.sh \
    && echo "export GOPATH=/workspace/go" >> /etc/profile.d/go.sh \
    && echo "export PATH=\$PATH:/usr/lib/go/bin:\$GOPATH/bin" >> /etc/profile.d/go.sh \
    && echo "GOROOT=/usr/lib/go" >> /etc/environment \
    && echo "GOPATH=/workspace/go" >> /etc/environment

LABEL template.name="go" \
      template.displayName="Go 1.23" \
      template.tools="go,sh"
