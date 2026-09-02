# 独立多 Key 管理镜像：上游 commandcode-proxy vendored 打包，单进程运行
# Node 20.19.4 + Alpine 3.21，与 publish CI 的 Node 20 runtime 对齐。
# 多架构 manifest 用 digest 固定，避免 tag 或底层镜像漂移。
# 更新时先执行：docker buildx imagetools inspect node:<node>-alpine<alpine>
# 审阅 manifest、Node/Alpine 版本和 amd64/arm64 后，连同 tag 一起更新 digest。
FROM node:20.19.4-alpine3.21@sha256:48022836f3fbf7d8cd398114b5091cbe3c4b6cd5a4f37f0e5b2aece7fd6d2fc4

RUN adduser -D -u 10001 app

WORKDIR /app
COPY package.json package-lock.json ./
COPY src ./src
COPY web ./web
COPY upstream ./upstream
COPY UPSTREAM_VERSION ./

RUN mkdir -p /data && chown -R app:app /data /app

USER app
ENV DATA_DIR=/data
ENV PORT=3080
EXPOSE 3080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "src/server.mjs"]
