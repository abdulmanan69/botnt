# ---------- stage 1: warm the Go cross-compile cache ----------
FROM golang:1.24-bookworm AS gowarm

ENV CGO_ENABLED=0 GOFLAGS=-mod=mod GOTOOLCHAIN=local
WORKDIR /src
COPY implant/ ./implant/
COPY server/stub/ ./server/stub/

# Pre-populate the build cache for every target the builder can emit, so the
# first in-dashboard build is fast instead of minutes of cold compilation.
RUN cd implant && \
    for t in windows/amd64 windows/386 windows/arm64 linux/amd64 linux/386 linux/arm64 linux/arm darwin/amd64 darwin/arm64; do \
      os=${t%/*}; arch=${t#*/}; \
      extra=""; [ "$os" = windows ] && extra="-H windowsgui"; \
      GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false -ldflags "-s -w $extra" -o /dev/null . || exit 1; \
    done && \
    cd ../server/stub && \
    for t in windows/amd64 windows/386 windows/arm64 linux/amd64 linux/arm64 linux/arm darwin/amd64 darwin/arm64; do \
      os=${t%/*}; arch=${t#*/}; \
      extra=""; [ "$os" = windows ] && extra="-H windowsgui"; \
      GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=false -ldflags "-s -w $extra" -o /dev/null . || exit 1; \
    done && \
    mkdir -p /go/pkg/mod /root/.cache/go-build

# ---------- stage 2: runtime ----------
FROM golang:1.24-bookworm

ARG INSTALL_GARBLE=0
ARG INSTALL_UPX=0

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=mod \
    PHANTOM_DATA=/data PHANTOM_BUILDS=/data/builds PHANTOM_PORT=8000 PHANTOM_HOST=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# optional hardening toolchain
RUN if [ "$INSTALL_UPX" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends upx-ucl && rm -rf /var/lib/apt/lists/*; \
    fi
RUN if [ "$INSTALL_GARBLE" = "1" ]; then \
      GOBIN=/usr/local/bin go install mvdan.cc/garble@latest; \
    fi

COPY --from=gowarm /root/.cache/go-build /root/.cache/go-build
COPY --from=gowarm /go/pkg/mod /go/pkg/mod

WORKDIR /app
COPY . /app

RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -q -r requirements.txt \
 && chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /data/builds /app/server/builds

ENV PATH="/opt/venv/bin:$PATH"

EXPOSE 8000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PHANTOM_PORT}/healthz" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["python3", "server.py"]
