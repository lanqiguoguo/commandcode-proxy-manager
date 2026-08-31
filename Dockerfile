# 独立多 Key 管理镜像：上游 commandcode-proxy vendored 打包，单进程运行
# 精简基础镜像：alpine:3.21 + apk nodejs（musl 原生、无 npm、自动多架构）
# 体积约 107MB，比 node:22-alpine（~233MB）小 54%
FROM alpine:3.21

RUN apk add --no-cache nodejs ca-certificates \
    && adduser -D -u 10001 app

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY upstream ./upstream
COPY UPSTREAM_VERSION ./

RUN mkdir -p /data && chown -R app:app /data /app

USER app
ENV DATA_DIR=/data
EXPOSE 3080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:3080/health >/dev/null || exit 1
CMD ["node", "src/server.mjs"]
