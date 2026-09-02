# commandcode-proxy-manager

独立的多 Key 管理网关：为 [commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)（上游）提供
**主备 Key 池 + 429 退避/同 Key 重试 + 官方额度富余度看板 + 持久化统计/历史记录 + 零构建管理前端**。
上游项目以 vendored 方式原样打包进本镜像（零改动、零 fork、同进程嵌入），上游更新时重新同步并发布镜像即可。

> 仅供学习研究。请遵守 Command Code 服务条款；保持与正常 CLI 一致的使用频率，超高并发可能触发风控。

## 功能

| # | 功能 |
|---|---|
| 1 | /v1/* 强制 clientToken 鉴权；未配置时回退 AdminToken（管理界面仍只认 AdminToken） |
| 2 | 退避结合官方额度：5h 窗口 / 每周窗口 / 订阅美元额度接近上限或耗尽时提前限制该 Key（quota_limited） |
| 3 | 上游 vendored 打包：构建期零网络，可复现，可 diff |
| 4 | CI 每天轮询上游正式版（v* tag / master），自动同步并发布新镜像（双 tag：latest + upstream-版本） |
| 5 | 主备 Key 池：任一时刻单一活跃 Key，主 Key 额度耗尽/退避才切换备 Key，带切换冷却 |
| 6 | 退避状态 / 用量统计持久化到 /data，重启不清零；统计按 5h / 每周 / 每月窗口 |
| 7 | 每 Key 历史记录：请求明细（模型/状态/token/延迟/重试）+ 筛选 + CSV 导出 |
| 8 | 429/402/零输出先同 Key 重试（默认 2 次），确属持续限流才退避并切换备 Key |
| 9 | 历史记录默认保留 7 天，可配置 1～31 天 |
| 10 | 每日轮询上游正式版（北京时间凌晨 4 点） |

## 架构

单容器、单 Node 进程：管理网关（3080，对外）→ 同进程嵌入的上游代理（127.0.0.1:3050，不对外）→ Command Code API。

    OpenAI / Anthropic SDK ──► :3080/v1/*（clientToken 鉴权）
    Browser ─────────────────► :3080/admin（管理 UI）· /admin/api/*（REST+SSE）
                                        │
                                        ▼  Bearer <池内 Key>
                              上游 proxy.mjs（vendored，零改动）
                                        │
                                        ▼
                              api.commandcode.ai（推理 + 额度探测）

## 快速开始

镜像采用精简基础镜像（alpine + 无 npm 的 nodejs），拉取体积约 29MB（node:22-alpine 基底约 58MB）。

Docker：

    docker run -d --name cc-proxy-manager -p 3080:3080 \
      -v ccpm-data:/data \
      ghcr.io/lanqiguoguo/commandcode-proxy-manager:latest

docker compose：

    docker compose up -d

本地开发（Node >= 18）：

    npm start          # 数据落在 ./data/

首次启动会**自动生成 AdminToken** 并打印到容器日志 / data/config.json；管理界面在 http://localhost:3080/admin 。

## 配置

环境变量（基础设施类优先于 data/config.json；**令牌类仅在磁盘 config.json 无值时初始化填充**，磁盘已有不同值时忽略 env 并打告警——UI 改密后重启不会被旧 env 静默回滚）：

| 变量 | 默认 | 说明 |
|---|---|---|
| PORT | 3080 | 管理网关端口 |
| HOST | 0.0.0.0 | 监听地址 |
| DATA_DIR | ./data（容器内 /data） | 持久化目录（keys.json / state.json / quota-cache.json / stats.jsonl / config.json） |
| ADMIN_TOKEN | 自动生成 | 管理端令牌（仅磁盘无值时初始化生效） |
| CLIENT_TOKEN | 空（回退 ADMIN_TOKEN） | /v1/* 客户端令牌（仅磁盘无值时初始化生效） |
| UPSTREAM_PORT / UPSTREAM_HOST | 3050 / 127.0.0.1 | 上游代理内部地址 |
| EMBED_UPSTREAM | 1 | 设为 0 时不嵌入上游（上游独立部署/测试场景） |
| SECURE_COOKIES | 空 | 设为 `1`/`true` 时给登录 SSE cookie 追加 `Secure` 属性（TLS 反代部署应开启，见「安全说明」） |

池策略等高级参数可在管理界面「设置」页修改（持久化到 data/config.json）。

## 客户端接入

OpenAI SDK：

    client = OpenAI(
        api_key="你的 clientToken（或 AdminToken）",
        base_url="http://127.0.0.1:3080/v1",
    )
    client.chat.completions.create(model="deepseek/deepseek-v4-flash", messages=[...])

Anthropic SDK：base_url 指向 http://127.0.0.1:3080 ，x-api-key 填 clientToken。

模型列表：GET http://127.0.0.1:3080/v1/models （同样需要 token）。

## 管理界面

- 总览：池状态卡片 + 每 Key 卡片（健康徽章、5h/每周/美元额度富余度进度条、实测用量、切换次数）
- Key 管理：主备顺序调整（↑↓）、新增/批量导入、有效性测试、启停、删除
- 历史记录：按 Key/时间/状态/错误类型筛选、分页、CSV 导出
- 设置：池策略、重试/退避参数、额度阈值、历史保留天数、clientToken/AdminToken
- 日志：系统事件实时刷新（新增 Key、退避、切换、额度受限等）

## 上游同步与镜像发布

    npm run sync:upstream    # 拉取上游 master → 覆盖 upstream/ → 更新 UPSTREAM_VERSION → 打印 diff

手动流程：sync → 提交 → push（GitHub Actions 自动构建推送 GHCR，tag：latest + upstream-<版本>）。

自动流程：.github/workflows/upstream-sync.yml 每天 04:00（北京时间）检查上游正式版 / master，
发现更新即自动 sync + 提交（push 触发 publish.yml 发镜像）；也支持 workflow_dispatch 手动触发，
并预留 repository_dispatch 事件（上游仓库不在控制范围内，无法由上游直接推送）。

## 数据文件（/data 卷）

| 文件 | 内容 |
|---|---|
| keys.json | Key 池（别名/明文 Key/主备顺序），权限 600 |
| state.json | 每 Key 退避/健康/切换统计（防抖落盘） |
| quota-cache.json | 每 Key 最近额度快照（避免重启探测风暴） |
| stats.jsonl | 请求历史追加日志（按保留天数自动清理，默认 7 天） |
| config.json | 管理端配置（含令牌） |

## 开发

    npm run dev       # watch 模式
    npm test          # 单元测试（scripts/unit.mjs）+ 端到端测试（scripts/e2e.mjs，mock 上游）

## 安全说明

- keys.json 权限 600，仅本地明文；管理 API 只回显掩码（user_ab***cd），日志不含 Key 明文
- 客户端令牌不会透传上游，上游只看到池内 Key
- 管理 API 与 /v1/* 分离鉴权；额度端点为非文档化接口，探测失败自动降级（stale），不影响推理主链路
- 令牌比较使用常量时间比较（SHA-256 摘要 + timingSafeEqual）；login 按来源 IP 限速：15 分钟内失败 10 次锁定 15 分钟（返回 429），成功登录即清零计数（计数为进程内存态，重启复位）。注意限速取 TCP 源地址：置于反向代理之后时所有请求共享代理 IP，限速退化为全局开关（误输 10 次会连带锁住所有管理员），需自行在反代层限流或接受该权衡
- **TLS 反代部署请设 `SECURE_COOKIES=1`**：登录下发的 SSE 专用 cookie（ccpm_sse）默认不带 `Secure`
  属性——官方部署形态为明文 HTTP 容器（3080 直接对外），默认开启会导致浏览器在 HTTP 下完全不回传
  cookie、SSE 实时推送失效。当你把服务置于 HTTPS 反代（Caddy/Nginx/Traefik）之后时，设置
  `SECURE_COOKIES=1`，login 与 logout 的 Set-Cookie 会同步附加 `Secure`，cookie 仅在加密信道传输。
