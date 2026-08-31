# 独立多 Key 管理镜像：上游 commandcode-proxy vendored 打包，单进程运行
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY upstream ./upstream
COPY UPSTREAM_VERSION ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data
EXPOSE 3080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD wget -qO- http://127.0.0.1:3080/health >/dev/null || exit 1
CMD ["node", "src/server.mjs"]
