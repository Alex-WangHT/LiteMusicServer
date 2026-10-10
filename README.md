# LitePlayer 音频 API

独立的多用户个人音频库：**密钥即用户**，没有用户名密码登录或公众注册。
网页只是可替换的 API 验证客户端，不参与权限判断和业务存储。

**全 Cloudflare 模式**：API 用 Workers，下载/提取用 Containers，数据用 D1/R2。
部署后无需本地电脑或 VPS 常驻运行，详见 [全云端部署指南](DEPLOY-CLOUDFLARE.md)。
下文的本地下载进程用于开发；普通 `deploy` 只部署 API，全云端请使用 `deploy:cloud`。

## 组成

- API Worker：用户身份、音频保存、个人库、歌单、播放授权。
- D1：用户密钥哈希、个人库归属、歌单顺序、任务租约和播放凭证。
- R2：音频文件。相同来源复用底层文件，各用户的收藏和歌单独立。
- Node.js 下载进程：从 API 领取任务，运行 yt-dlp 下载，再上传给 API。
- public/：纯静态验证客户端，单独托管；不打包进 Worker。
- scripts/web.mjs：只提供静态文件的本地验证服务器，不代理 API、不保存密钥。

本地 API 为 http://127.0.0.1:8787，验证网页为 http://127.0.0.1:5173。
访问 API 根路径返回 JSON 404 是正常行为，它不再提供网页。

## 密钥身份与播放授权

服务端生成 256 位随机用户密钥，数据库仅存 SHA-256 哈希，明文只在创建/轮换时返回一次。
请求携带 `Authorization: Bearer <用户密钥>`；`GET /api/me` 验证身份。
用户密钥相当于完整账户凭证，丢失后无法从哈希恢复。

ADMIN_TOKEN 仅用于创建用户，不能访问普通用户 API。
DOWNLOADER_TOKEN 仅用于后台任务接口，不能作为用户密钥。
两者均不得放入验证网页。

`POST /api/me/key` 轮换密钥，用户 ID、音频库和歌单保留；旧密钥立即失效。
旧播放链接也因 key_version 改变而失效。已下载到浏览器的字节无法收回。
如果轮换响应因网络中断丢失，新密钥不能从数据库找回，请在可靠网络中执行。

音频接口不再公开：
- 服务端客户端可以给 GET/HEAD 音频请求添加 Bearer 用户密钥。
- 原生 HTML audio 不能自定义 Bearer 头，先 POST playback 获取有效期 1 小时的临时链接。
- 临时链接只授权指定音频，持有者在有效期内可播放；不要将用户密钥放入 URL。
- 移出个人库或轮换密钥会撤销相应链接。音频响应为 private, no-store。
- 验证网页退出仅清除内存中的身份，不会撤销密钥；需要撤销时请轮换。

## 本地启动

需要 Node.js 22+、近期版本的 [yt-dlp](https://github.com/yt-dlp/yt-dlp)。
Windows 可将校验后的官方可执行文件放到 .tools/yt-dlp.exe，Linux 设置 YTDLP_PATH 为安装路径。
仅支持抖音（Douyin）和 Bilibili，不支持 YouTube、TikTok 或其他平台。
Bilibili 支持 BV 完整链接和分 P，直接保存 M4A/WebM 音轨。
抖音支持 www.douyin.com/video/数字ID、iesdouyin.com/share/video/数字ID、modal_id 链接，以及 v.douyin.com 分享短链接。
短链接逐跳校验域名并转换为完整视频 ID 后去重。不支持直播、图集、用户主页、b23.tv 短链接。
抖音使用 yt-dlp 下载媒体，再由 FFmpeg 提取为 AAC/M4A（160 kbps），不会把 MP4 视频当作音频保存。
npm ci 会通过 ffmpeg-static 安装当前平台的 FFmpeg；可用 FFMPEG_PATH 指定已有可执行文件。
抖音中间媒体文件也限制为 80 MiB。历史其他平台记录保留，但不接受新保存、不领取下载任务、也不能重试。
最大 80 MiB / 2 小时，单次提取或下载命令超时 5 分钟。

```sh
npm ci
# 将 .dev.vars.example 和 .env.example 复制为对应的无 example 文件
# 设置两组不同的 ADMIN_TOKEN、DOWNLOADER_TOKEN，两个文件对应值一致
npm run db:local
npm run dev
```

另开终端：

```sh
npm run user:create -- --name=我的音频库
npm run dev:web
```

创建命令把返回的明文密钥保存在项目内被 git 忽略的 `.user-<id>.json` 文件中。
用户自行安全保存；生产环境应限制此文件权限。Windows 不应依赖 POSIX mode 的访问保护。
已有旧版音频时，首次创建可使用 `--import-existing`，将**没有用户归属**的旧记录加入新用户库。
迁移本身不自动给任何用户分配旧音频，也不会删除 R2 文件。

打开验证网页，填写 API 地址和文件中的 key，点击“连接”。
输入以下链接验证：

```text
https://www.bilibili.com/video/BV1EAYszPEP9
```

另开终端运行 `npm run downloader` 才会处理新下载任务。
无下载进程时任务保持 queued。D1 原子领取和 15 分钟租约防止同时重复领取，
进程崩溃后可接管，最多 3 次领取；明确失败需调用 retry。
下载进程只主动连接 API，不需要公网入站端口或 Cloudflare 管理权限。

当前工作区的已有 BV 音频已迁入创建好的个人用户；对应凭证路径配置在 .env 的 USER_KEY_FILE。
验证网页仅在内存保留输入密钥，刷新页面需重新输入；轮换后请保存新值。
网页当前展示最近 100 条音频，完整遍历可用 API 的 offset 分页。

## API 契约

除 health、管理员创建用户和带 ticket 的音频访问外，以下接口都要求用户 Bearer 密钥。
所有错误统一返回 `{ "error": "..." }`；缺少身份返回 401，不属于自己的资源返回 404。

| 方法与路径 | 请求 / 作用 |
| --- | --- |
| GET /health | 存活检查 |
| POST /api/admin/users | ADMIN_TOKEN；JSON name，可选 import_existing；201 返回 user 和一次性 key |
| GET /api/me | 当前用户 id、name、created_at |
| POST /api/me/key | 返回一次性新 key，保留用户数据并废止旧 key |
| GET /api/videos?offset=0 | 当前用户音频，100 条/页，返回 next_offset |
| POST /api/videos | JSON url；保存到个人库，已有文件直接复用；200 ready / 202 queued 等 |
| GET /api/videos/:id | 自己库中的音频元数据与状态 |
| DELETE /api/videos/:id | 移出自己的库，同时移除相关歌单条目和播放凭证 |
| POST /api/videos/:id/retry | 重新排队失败下载 |
| POST /api/videos/:id/playback | 返回 audio_url 和 expires_at（Unix 秒），有效期 1 小时 |
| GET /api/videos/:id/audio | Bearer 或 ticket；支持 Range、ETag、If-Range |
| HEAD /api/videos/:id/audio | 相同授权；查询大小和类型 |
| GET /api/playlists | 自己的歌单 |
| POST /api/playlists | JSON name；201 返回 id、name |
| GET /api/playlists/:id | 歌单及按 position 排序的音频 |
| PATCH /api/playlists/:id | JSON name，修改名称 |
| DELETE /api/playlists/:id | 删除自己的歌单，音频库不变 |
| PUT /api/playlists/:id/items | JSON video_ids，有序数组，原子替换歌曲和顺序 |

歌单最多 100 首；数组为空即清空。数组不可重复，且每首必须属于当前用户。
多个客户端同时修改采用后提交覆盖的语义。
数据库外键保证移出音频库时级联移除自己的歌单条目，不影响其他用户。

删除个人收藏**不物理删除共享 R2 文件**。无人收藏的文件作为缓存保留，
当前未实现自动垃圾回收。任务的来源元数据/下载状态也是共享的；个人归属和歌单不共享。
R2 文件永远经有权限的 API 读取，不开放公共 bucket URL。

## 请求示例

```powershell
$headers = @{ Authorization = 'Bearer <用户密钥>' }
$body = @{ url = 'https://www.bilibili.com/video/BV1EAYszPEP9' } | ConvertTo-Json
$video = Invoke-RestMethod 'http://127.0.0.1:8787/api/videos' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
# 等待状态 ready
$playback = Invoke-RestMethod "http://127.0.0.1:8787/api/videos/$($video.id)/playback" -Method Post -Headers $headers
$playback.audio_url
```

返回的 audio_url 可用在任何前端的 `<audio controls src="…"></audio>`。
没有 ticket 的 audio_url 是受保护 API 地址，不能直接匿名打开。

## 测试

Worker 和独立网页需已启动。集成测试期间暂停下载进程，确保无其他排队任务。

```sh
npm test
npm run test:integration
# 在 .env 指定 USER_KEY_FILE=.user-<id>.json，或 USER_KEY
npm run test:video
npm run test:browser
```

集成测试覆盖多用户隔离、管理员与用户权限分离、鉴权、去重、租约、R2 上传、
206/416/HEAD/ETag/CORS、歌单排序/越权、密钥轮换及播放凭证撤销。
生成独立测试用户及合成媒体，结束后移出测试用户个人库；共享缓存和测试用户保留本地供检查。
视频测试输出 test-results/video.json 和完整音频副本。
浏览器测试从 5173 调用 8787，验证解码播放及跳转到第 30 分钟，输出 browser.json / player.png。
浏览器默认使用已安装的 Edge，可用 BROWSER_CHANNEL=chrome。
此前指定的 BV 音频已成功保存，后续测试会复用文件，而非重复下载。

## Cloudflare 部署

```sh
npx wrangler login
npx wrangler d1 create liteplayer
npx wrangler r2 bucket create liteplayer-audio
```

将真实 D1 database_id 填入 wrangler.jsonc，启用 R2，然后：

```sh
npm run db:remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DOWNLOADER_TOKEN
npm run deploy
```

使用新的高强度生产密钥，不使用本地开发值。Worker 部署产物不包含 public/。
将下载机 .env 的 WORKER_URL 改为真实 HTTPS API 地址，配置相同 DOWNLOADER_TOKEN。
使用 API 或 user:create 创建用户，再将 public/ 放到任意静态托管；网页填写 API 地址即可。
默认 ALLOWED_ORIGIN 为 *，因采用 Bearer 而非 cookie，不启用跨站 cookie；
可以设置为验证站点的具体 Origin。生产 API 与前端应使用 HTTPS。
浏览器 CORS 不是用户隔离机制，实际访问权限由用户密钥和数据库归属校验。

可选 YTDLP_PROXY 和用户自行提供的 YTDLP_COOKIES_FILE。
本项目不自动读取浏览器 Cookies。
当前为可运行版本，尚未加入生产配额、请求限流、账单管理和无人收藏文件的清理策略。

参考：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
