# 基础镜像默认走 DaoCloud 加速（国内 NAS 直连 docker.io 常超时）。
# 加速站故障（502 / 超时）时用 --build-arg REGISTRY=其它加速站/library 切换；
# 已在 Docker 配置 registry-mirrors 时可设 REGISTRY=library 直接用官方名。
ARG REGISTRY=docker.m.daocloud.io/library

# ---- frontend ----
# vite 输出到 ../server/webui/dist，这里保持 web/ 与 server/ 同级的目录结构
FROM ${REGISTRY}/node:22-alpine AS fe-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- backend ----
FROM ${REGISTRY}/golang:1.26-alpine AS be-builder
WORKDIR /src/server
# 国内直连 proxy.golang.org 常超时
ENV GOPROXY=https://goproxy.cn,https://goproxy.io,direct \
    GOSUMDB=sum.golang.google.cn
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=fe-builder /src/server/webui/dist ./webui/dist
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/simplemusic .

# ---- runtime ----
FROM ${REGISTRY}/alpine:3.20
RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -S -g 1000 app && adduser -S -G app -u 1000 app \
 && mkdir -p /app/data && chown -R app:app /app
WORKDIR /app
ENV TZ=Asia/Shanghai \
    SM_LISTEN=:8080 \
    SM_DATA_DIR=/app/data
# secret.key、音频与封面缓存都在这里，挂载数据卷即可持久化
VOLUME ["/app/data"]
COPY --from=be-builder --chown=app:app /out/simplemusic /app/simplemusic
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/version.json || exit 1
ENTRYPOINT ["/app/simplemusic"]
