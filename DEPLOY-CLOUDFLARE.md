# 全 Cloudflare 部署（包括下载）

API → D1 持久化任务 → Cloudflare Container（yt-dlp + FFmpeg）→ API → R2。
服务器身份、个人库、歌单、授权播放仍由同一个 Worker 处理。
本地电脑只用于构建和部署，成功部署后不需要一直开机，也不需要本地下载进程。

## 已提供的实现

- `wrangler.cloud.jsonc`：云端专用配置，不影响原有本地开发配置。
- `src/cloud-worker.mjs`：API 请求成功后唤醒下载容器，Cron 每分钟补偿检查任务。
- `src/dispatch.mjs`：仅在 D1 有待执行或租约过期任务时唤醒；没有任务不会启动容器。
- `downloader/server.mjs`：收到私有的、带下载密钥的 POST /run 后返回 202，在 Linux 进程中执行下载。
- `Dockerfile`：Node.js 24、固定版本 yt-dlp、系统 FFmpeg，非 root 运行。
- `.dockerignore`：构建上下文白名单，排除 .env、用户密钥、Cookies、本地数据和测试产物。

所有唤醒指向一个 Durable Object / Container，max_instances=1。
每个容器进程只处理一项任务，完成回写后自行退出；有积压时下一次 Cron 继续唤醒。
进程内重复唤醒不会同时启动另一个任务。D1 原子租约仍负责并发安全和崩溃接管。
watchdog 在 14 分钟终止异常任务，15 分钟租约到期后可重领；sleepAfter=15m 为额外兜底。
Cron 最多约一分钟后发现任务（首次容器部署/冷启动可能更久）。不依赖浏览器长连接或 waitUntil 跑完整下载。

## 部署前提

1. Cloudflare Workers Paid 账户并启用 R2 / Containers。容器和存储、出站流量按用量计费。
2. 构建机器可运行 Docker Linux 容器（linux/amd64）。启动 Docker Desktop 后 `docker info` 应成功。
3. `npx wrangler login` 完成登录，随后 `npx wrangler whoami` 确认账户。

当前采用 standard-2（1 vCPU / 6 GiB）单实例，适合 FFmpeg 提取；费用并非只包含 Worker 请求。
如果调整到更小规格，应重新测量转码时间，当前音轨提取有 60 秒超时。
未自动开通付费订阅。

## 部署步骤

```sh
npm ci
npx wrangler login
npx wrangler d1 create liteplayer
npx wrangler r2 bucket create liteplayer-audio
```

如果资源已存在则复用，不重复创建。将真实 D1 database_id 填入 `wrangler.cloud.jsonc`。
将 WORKER_URL 填为此 Worker 最终的 HTTPS Origin，例如：

```text
https://liteplayer.<你的-workers-子域>.workers.dev
```

不能保留 `.invalid` 占位符，也不能写本机 127.0.0.1。
这是容器回写 API 的受信任地址，取自部署配置，不接受用户提交的回调地址。

```sh
npm run db:cloud
npx wrangler secret put ADMIN_TOKEN --config wrangler.cloud.jsonc
npx wrangler secret put DOWNLOADER_TOKEN --config wrangler.cloud.jsonc
npm run check:cloud
npm run deploy:cloud
```

使用全新且不同的生产密钥。DOWNLOADER_TOKEN 由 Durable Object 在启动时注入容器环境，
不写入镜像。Wrangler 负责构建并上传镜像、发布 Worker 和容器配置。
首次发布后可能需要数分钟准备容器：

```sh
npx wrangler containers list --config wrangler.cloud.jsonc
```

部署成功后，将管理电脑 .env 的 WORKER_URL 和 ADMIN_TOKEN 改为生产值，再执行：

```sh
npm run user:create -- --name=我的音频库
```

网页仍单独托管：public/ 放在任意静态站点，填写生产 API 地址及新用户密钥即可。
不需要运行 `npm run downloader`。本地 D1/R2/用户密钥不会自动复制到云端；新云端用户需重新提交视频链接。

## 云端验收

1. 提交已验证的 Bilibili 视频，获得 queued 任务。
2. 无本地下载进程的情况下，观察任务变为 processing / ready。
3. 检查标题、大小及 R2 对象，签发 playback 链接验证完整读取、206 分段和播放。
4. 检查容器任务结束后停止，空队列不会反复唤醒。
5. 再用实际抖音视频测试。Cloudflare 出口 IP 与本机不同，平台可能要求验证、Cookies 或限制地区；不能用本地成功代替云端实测。

当前镜像没有携带个人 Cookies。现有本地 YTDLP_COOKIES_FILE 不会被自动上传。
如果云端出现登录/风控限制，需要另行配置受控的 Secrets/Cookies 注入，不能通过公开前端传输登录凭证。

## 本次验证边界

已通过 Node 单元测试：容器启动接口鉴权、并发触发合并、空队列不唤醒、任务唤醒、音轨提取。
真实 Docker 镜像构建、云端发布和平台下载必须在 Docker 引擎和 Cloudflare 登录恢复后执行。
`check:cloud` 的 dry-run 也会构建容器镜像；若只检查 Worker bundle，可以运行：

```sh
npx wrangler deploy --config wrangler.cloud.jsonc --dry-run --containers-rollout=none
```

这条命令**不验证容器镜像可运行**，不能替代 check:cloud。

参考：[Containers 入门](https://developers.cloudflare.com/containers/get-started/)、
[计费](https://developers.cloudflare.com/containers/platform/pricing/)、
[实例规格](https://developers.cloudflare.com/containers/platform/limits/)。
