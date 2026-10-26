# 影视播放站（个人自用）

前后端一体的影视播放站：搜索 → 详情选集 → 网页播放。

片源走 macCMS（苹果CMS）采集站的公开接口，播放走 HLS。

---

## PM2 部署（Linux 服务器 / NAS · 推荐不用 Docker）

服务器上装好 Node.js ≥ 20 后，进项目目录执行：

```bash
bash scripts/pm2-deploy.sh
```

脚本会自动：检查环境 → 安装 PM2（没有才装）→ 装依赖 → 构建 `dist/` → 清理开发依赖 →
`pm2 startOrReload` → `pm2 save`。

首次部署后执行一次开机自启：

```bash
pm2 startup     # 按提示复制并执行它输出的 sudo 命令
pm2 save
```

常用命令：

```bash
pm2 status
pm2 logs movie-player
pm2 restart movie-player
```

手动更新（Web 一键更新不可用时的 SSH 兜底）：

```bash
bash scripts/pm2-deploy.sh --update     # git fetch/reset → 装依赖 → 构建 → pm2 重载
```

> Web「设置 → 一键更新并重启」在 PM2 下会主动退出进程、由 PM2 重新拉起，
> **不会出现两个 node 抢 8848 端口**。非 PM2 运行则沿用原来的自愈重启。

### 绑定 GitHub 私有仓库

设置页填仓库地址（如 `https://github.com/用户名/movie-player.git`）和分支，
再填一个 GitHub Personal Access Token（勾 `repo` 权限即可）。Token 只保存在服务器的
`data/update-config.json`，不会回显到页面、不会进仓库；拉取时临时注入，结束后自动从
`.git/config` 恢复干净地址。

设置页打开后会自动检查远端是否有新提交；有更新时点「⬇ 一键更新并重启」即可。

---

## 飞牛 NAS 部署（Docker，推荐）

飞牛 fnOS 的 Docker 套件直接支持 compose，前后端在同一个容器里一起跑：

1. 把整个项目目录拷到 NAS 上（如 `/vol1/1000/docker/movie-player`）
2. fnOS Docker 套件 → Compose → 新增 → 选择 `docker-compose.yml`，或者 SSH 执行：

   ```bash
   cd /vol1/1000/docker/movie-player
   docker compose up -d --build
   ```

3. 浏览器打开 `http://NAS的IP:8848`

收藏/历史通过 volume 挂载存到 NAS 磁盘（`./data`），重建容器不丢数据。

想把 NAS 硬盘里已有的视频直接挂进来看？见《本地媒体配置教程.md》。

> **换电脑 / 接手开发先读《开发进展.md》**：仓库分工、行尾与 dist 约定、已完成功能、已知限制。

### 不用 Docker（直接跑 Node）

NAS 装好 Node.js ≥ 20 后：

```bash
cd /vol1/1000/docker/movie-player
npm install --omit=dev
npm run build
npm start          # 即 node dist/server.js，无需 tsx
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址；只在本机跑可设 `127.0.0.1` |
| `PORT` | `8848` | 监听端口 |
| `DATA_DIR` | 项目根 `data/` | 收藏/历史目录，Docker 里为 `/app/data` |

> ⚠️ 默认监听 `0.0.0.0`，局域网内任何设备都能访问。NAS 上的服务不建议映射到公网。

---

## 本机开发

```bash
npm install
npm run dev        # tsx watch 热重载
```

打开 **http://127.0.0.1:8848**

---

## 功能

| 功能 | 说明 |
|---|---|
| 搜索 | 按片名搜，可搜演员，多源同时搜并合并结果 |
| **影视仓** | 顶栏独立入口（`dyrs.html`），接的是 dyrs.me 那套站点的片源：首页热播 + 分类筛选 + 分页 + 搜索。频道条有 **8 个入口**：5 个上游真实频道（电影/电视剧/综艺/动漫/短剧）+ 3 个**预设筛选**（纪录片 / 蓝光 / 美剧，界面用虚线描边区分）。筛选支持分类·地区·年份·排序·线路(蓝光)·文艺片。详情页列出**全部线路**（按「上游直接给真实 m3u8」优先排序）与选集，点播复用老播放页（`play.html?source=dyrs`）。**老界面与 macCMS 播放链路完全不受影响** |
| **多镜像线路池** | 影视仓背后是 34 条同库镜像。不做「单点线路」，而是候选池最多试 3 条、失败自动换、成功的提到池首，缓存按路径而不是完整地址（换镜像仍命中） |
| **多维筛选** | 两个入口都能按 **分类 × 地区 × 年份**（主库还有**语言**）组合筛选，同轴单选、点已选值取消、已选条件以 chips 展示、可一键清除、跨分页与刷新保留、URL 可分享。影视仓的值来自上游页面实时解析（每频道词表不同，电影 25 分类/短剧 26 分类），主库的值来自 `src/facets.ts` 词表 —— 走 macCMS 的**服务端** `area`/`year`/`lang` 过滤（实测 `area=美国` 能把 4978 部收窄到 1454 部，分页也稳） |
| 自绘播放器 | 优酷/腾讯风格控制栏：缓冲进度条+时间气泡+拖拽圆点、快退/快进 10 秒、倍速、音量、画中画、全屏、自动隐藏、双击全屏 |
| 广告剔除 | 服务端清洗 m3u8（异域名/编号断接/广告特征），播放器内提示「已自动跳过 N 个广告片段」。**只在服务端链路（`/api/hls`、`/api/proxy`）生效**；客户端直连 CDN 时请求不经过服务器，不含广告过滤。重建列表时保留上游的 `TARGETDURATION` / `MEDIA-SEQUENCE` 等全局标签 |
| 频道分层 | 电影 / 电视剧 / 短剧 / 综艺 / 纪录片 / 动漫 / 体育 / 解说，不把全部分类平铺。**按源站 `class` 树的父节点归类**，读不到层级才退回名称规则 |
| 分类归并 | 跨源同义分类自动合并（`日剧`+`日本剧`→一个，`港剧`/`港澳剧`/`港台剧`→`香港剧`），实测 8 源 104 个分类名归并后「电视剧」从 15 项降到 9 项；`演员`/`新闻资讯` 这类非影视分类直接不展示 |
| 分类浏览 | 分类**自动采集**并按频道归组（各源分类 id 不同，不能硬编码），**结果落盘**，重启秒开（冷启动 5s / 缓存 16ms，旧实现 57.8s） |
| 线路聚合 | 主库**跨源聚合线路**：搜索按 `name\|year` 去重只留一张卡，详情再把各源的同名片线路合起来（《嫁金钗》2 条 → 11 条，可播 1 → 6 条），每条带 `source`/`sourceName`；播放页用 `ln`/`ls`（线路名 + 源）定位，不怕线路条数浮动 |
| 分享页解析 | 采集站很多线路给的是网页（`…/share/<hash>`、`…/play/<id>`），页面里写着带 `sign` 的真 m3u8。服务端 `/api/expand` 解析一次即可播：**《嫁金钗》11 条线路全部可播，⚠ 归零**（原来 5 条被误判） |
| 封面海报 | 渐进式加载：列表先出，海报随后补上 |
| 线路切换 | 一部片多个片源，随时切换 |
| 选集 | 剧集自动列出全部集数 |
| 续播 | 每 5 秒存一次进度，下次打开自动跳到上次位置 |
| 收藏 | 本地保存 |
| 观看历史 | 带进度条，点击继续看 |
| 跳过片头片尾 | 手动标记一次，同剧所有集生效，自动连播 |
| 本地媒体 | `LOCAL_MEDIA_DIR` 指向视频目录即可浏览播放，见《本地媒体配置教程.md》。支持 TS/M2TS/FLV（mpegts.js 软解）与 mp4/mkv/webm 等 30+ 种后缀 |
| 媒体库海报墙 | 本地媒体默认视图。界面照**飞牛影视**做：深色主题、顶部「最近添加」大图、按文件夹分行横向海报墙、集数角标、移动端自适应。递归扫描整个目录，支持搜索、视频/音频筛选、按名称/时间/大小排序 |
| 封面识别 | 四级策略：同名图片（`xxx.jpg` / `xxx-poster.png`）→ 同目录海报（`poster`/`folder`/`cover`）→ **NAS 上 ffmpeg 抽帧**（MKV/HEVC/RMVB 都能出图，落盘缓存 `data/covers/`）→ 浏览器抓帧（不需要 ffmpeg，但只能处理浏览器能解码的 mp4/webm） |
| **播放方案自动决策** | 点开视频先由服务端 ffprobe 读出真实编码：H.265/HEVC、MPEG-2、VC-1、RMVB、AC3/DTS/TrueHD、10bit/4:4:4 的 H.264 一律**直接转码**，不等浏览器报错；H.264+AAC 直连；TS/FLV 交给 mpegts.js 软解 |
| **服务端转码** | ffmpeg 实时转 H.264 + AAC 的 HLS，hls.js 播放。**硬件编码器优先**（QSV / VAAPI / NVENC / VideoToolbox / AMF），起不来自动退回 CPU 软编并把坏的编码器拉黑。只取第一条视频 + 第一条音频、丢弃字幕流（MKV 的内封字幕装不进 MPEG-TS，会让转码直接失败）。同时最多 2 路，空闲 10 分钟回收，卡住 120 秒自动判失败 |
| **运行环境诊断** | 本地媒体页「⚙ 诊断」：ffmpeg 路径与版本、可用硬件编码器、当前实际用哪个、转码路数与磁盘占用 |
| 快捷键 | 空格、←/→、↑/↓、F、M、P/N |
| 一键更新 | 网页「设置」页绑定 git 仓库，点一下自动拉取→覆盖→装依赖→自动重启，见《一键更新教程.md》 |

---

## 播放原理

```
浏览器 (hls.js)
   │
   ├─ 元数据 ──→ 后端 /api/*  ──→ 采集站 API   （采集站无 CORS，必须代理）
   │
   └─ 视频流 ──→ ① CDN 直连    （首选：HTTPS 源，浏览器直接取 m3u8 / 分片，完全不经过服务器）
                 └ 直连失败 ↓
                 ② /api/proxy   （兜底：分片由本机带 Referer 中转，仍会清洗广告）
                 ③ /api/hls     （HTTP 源专用：HTTPS 页面不能直连 HTTP 流，由服务端转成同源 HTTPS 播放列表）
```

**客户端直连优先。** 采集站 CDN 本身带 `Access-Control-Allow-Origin: *`，浏览器可以直接取 master / media 列表和分片。这样服务器只承担元数据接口，不会因为「服务器出口 IP 被 CDN 拒绝 / 服务器到 CDN 不通」导致 `/api/hls` 404。直连发生网络类错误时才回落 `/api/proxy`，并在本次会话里记住；切换线路会清掉记忆、重新试直连。HTTP 源因为混合内容限制，仍走 `/api/hls`。

> 广告过滤只在服务端链路（`/api/hls`、`/api/proxy`）生效。客户端直连不经过服务器，因此没有广告剔除，也不回传 `X-Ads-Removed`；这是「保证能播」优先于「剔除广告」的取舍。

> 修掉的两个坑：<br>
> 1. **「直连失败，转为代理」误报** —— 以前任何致命错误都弹这句。现在只有 `networkError`（分片/子列表在浏览器侧取不到）才回落代理；媒体错误先 `recoverMediaError()` 原地恢复一次；解析错误直接提示换线路。<br>
> 2. **回落代理后剧中广告全回来了** —— 代理链路走 `rewriteM3u8` 直接转发，完全绕过了广告过滤。现在 `/api/proxy` 复用同一套 `processPlaylist`（分片包一层代理，`rewriteSegments = true`），广告照剔，`X-Ads-Removed` 也照回传。

两条路径都在真实浏览器里验证过：都是 `1080x608`、`readyState=4`、`currentTime` 正常推进。

---

## 添加片源

编辑 `src/config.ts`，往 `SOURCES` 数组加一行即可，**不需要改任何逻辑**：

```ts
export const SOURCES: SourceConfig[] = [
  { id: 'lziapi', name: '量子资源', base: 'https://cj.lziapi.com/api.php/provide/vod/' },
  { id: 'ffzy',   name: '非凡资源', base: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
  // 加在这里
];
```

要求是标准的 macCMS 采集接口（`?ac=list` / `?ac=detail`）。

**加之前先探一下**，别把死源写进配置：

```bash
node scripts/source-probe.mjs --maccms https://某个站/api.php/provide/vod/
```

它会给状态码 / 耗时 / 条数 / `total`，活着的还会直接打印**可粘贴的 `SOURCES` 片段**。

某个源挂了会自动跳过（`/api/health` 能看到状态），连续 3 次失败会被熔断 10 分钟后自动重试，不会影响其他源。

---

## 调整频道分层

分类归到哪个频道，**优先看源站自己的分类树**（`ac=list` 响应里的 `class` 字段带 `type_pid`）：

```
父分类 = 电影片 / 电影            → 电影
父分类 = 连续剧 / 电视剧           → 电视剧
父分类 = 综艺片 / 综艺             → 综艺
父分类 = 动漫片 / 动漫             → 动漫
父分类 = 体育 / 体育赛事           → 体育
父分类 = 短剧 / 爽文短剧 / AI漫剧   → 短剧
```

读不到父节点时（`tyyszy / sdzy / hongniu / jinying` 只给 id+name），才退回名称规则：

```
含 体育/足球/篮球/网球/斯诺克…  → 体育
含 动漫/动画/番剧…            → 动漫
含 综艺/真人秀/脱口秀…         → 综艺
含 解说/速看/盘点…            → 解说
短剧子类型名单（AI漫剧/爽文短剧/古装仙侠/女频恋爱…） → 短剧
含 纪录/纪实/BBC…             → 纪录片
以「片」结尾                    → 电影
以「剧」结尾                    → 电视剧
其余                            → 其他
```

顺序有意义：先判专有词，最后才用「片 / 剧」结尾兜底，
否则「喜剧片」「剧情片」会因为含「剧」字被误判成电视剧，
「短剧」也会被并进电视剧和长剧混在一起。

注意「纪**录**片」和「记**录**片」是两回事：后者是采集站里的老式电影分类，结论仍是电影（单测锁着）。

**跨源同义分类会自动归并**（`src/channels.ts` 的 `CATEGORY_ALIAS`）：
`日剧→日本剧`、`港剧/港澳剧/港台剧→香港剧`、`台剧→台湾剧`、`内地剧→国产剧`、`中国动漫→国产动漫`…
实测 8 个源一共 104 个分类名，归并后「电视剧」从 15 项降到 9 项。
非影视分类（`演员`/`新闻资讯`/`未分类`…）进 `CATEGORY_BLOCK` 直接不展示。

规则判不了的特例，在 `src/config.ts` 里加一行即可：

```ts
export const CHANNEL_OVERRIDES: Record<string, ChannelName> = {
  '电影解说': '解说',
  '某个奇怪的分类名': '电影',
};
```

只显示有内容的分类——`MIN_CATEGORY_TOTAL`（默认 50）以下的僵尸分类会被自动过滤。

---

## 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 各片源存活状态（含 `disabled`：连续 3 次失败会被熔断 10 分钟） |
| GET | `/api/search?wd=` | 搜索（多源合并） |
| GET | `/api/channels?force=1` | **按频道分组的分类**（首页用这个）。`force=1` 重采；`counts=1` 额外补每个分类的条数（128 次上游请求，默认不补，不补时首屏 5s → 缓存后 16ms） |
| GET | `/api/categories?force=1` | 扁平分类清单 |
| GET | `/api/list?type=&source=&page=&area=&year=&lang=` | 分类分页列表（**不含封面**，快）。`area`/`year`/`lang` 是**服务端筛选**；取值先归一（`中国大陆`→`大陆`）。返回 `applied`（生效的筛选）与 `facetsIgnored`（该源不支持此筛选） |
| GET | `/api/facets` | 主库可用的筛选词表（地区 20 / 年份 37 / 语言 6），前端直接渲染 |
| GET | `/api/covers?ids=1,2,3&source=` | **批量取封面/年份**（渐进式补图） |
| GET | `/api/detail?id=&source=&name=` | 详情 + 线路 + 选集。**线路跨源聚合**（同一部片在多个采集站的线路合并，每条带 `source`/`sourceName`），`?merge=0` 关闭聚合、`?force=1` 跳过缓存 |
| GET | `/api/detail-by-name?name=&source=&year=` | 按片名跨源找同一部片 |
| GET | `/api/expand?url=` | **分享页/播放页 → 真 m3u8**：采集站大量线路给的是 `…/share/<hash>`、`…/play/<id>` 网页，页面里写着带 `sign` 的真地址。解析结果缓存 10 分钟 |
| GET | `/api/proxy?url=&ref=` | m3u8 / 分片 / 图片代理（兜底）。播放列表会走和 `/api/hls` 同一套广告过滤，分片再包一层代理 |
| GET | `/api/local?path=&root=` | 本地媒体目录列举（文件夹视图） |
| GET | `/api/local/library?path=&root=` | **媒体库**：递归扫描整棵目录（海报墙用） |
| GET/POST/DELETE | `/api/local/dirs` | 自定义本地目录管理 |
| GET | `/api/local/file?path=&root=` | 本地视频/音频/封面图流（支持 Range，按扩展名给 MIME） |
| GET | `/api/local/cover?path=&root=` | **视频封面**：ffmpeg 抽一帧（MKV/HEVC 等也行），落盘缓存；无 ffmpeg 时 404，前端回退浏览器抓帧 |
| GET | `/api/local/playplan?path=&root=` | **播放方案**：先读编码，返回 `direct` / `transcode` / `mpegts` 与原因 |
| GET | `/api/local/info?path=&root=` | 编码信息（视频/音轨/色彩格式/分辨率/时长） |
| GET | `/api/local/check?path=&root=` | 文件体检：ffmpeg 真解码头尾各 15 秒，区分「文件坏了」和「浏览器不行」 |
| GET | `/api/local/transcode/start?path=&h=&force=` | 开始（或复用）转码，返回 HLS 地址与 key；`force=1` 清掉重转 |
| GET | `/api/local/transcode/status?key=` | 转码进度（状态 / 已转秒数 / 编码器 / 失败原因） |
| GET | `/api/local/transcode/:key/:file` | 转码产物（`index.m3u8` 与 `seg*.ts`） |
| GET | `/api/local/diag?rescan=1` | **运行环境诊断**：ffmpeg 路径/版本/硬件编码器/转码占用 |
| GET/POST/DELETE | `/api/favorites` | 收藏 |
| GET/POST/DELETE | `/api/progress` `/api/history` | 观看进度与历史 |
| GET/POST | `/api/update/config` | 一键更新的仓库配置 |
| POST | `/api/update/init` | 首次绑定仓库（git init + fetch + reset --hard） |
| POST | `/api/update/check` | 检查更新（落后多少提交） |
| POST | `/api/update/run` | 一键更新：拉取→覆盖→装依赖→自动重启 |
| GET | `/api/update/status` | 更新任务进度（前端轮询） |

### dyrs 体系接口复刻（wzzycc 模板）

把 `dyrs.me` 那套自研 CDN 接口**一比一复刻**到本站，方便别人按它的规范对接。
抓包记录与实现细节见 [`docs/dyrs接口复刻说明.md`](docs/dyrs接口复刻说明.md)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/videox/least` | 线路发现，`{urls,least,sion_id}`（与原站同格式，10 分钟缓存） |
| GET | `/api/dyrs/ip?line=` | 线路探活，`{ok,ip,ms,...}` |
| GET | `/api/dyrs/fastest?n=` | 并发探活挑最快线路 |
| GET | `/api/dyrs/m3u8?origin=&url=` | 主接口。**默认 302**（同原站）；`&proxy=1` 抓回重写后直出 |
| GET | `/api/dyrs/super?id=&origin=` | CDN 主列表（master，重写后） |
| GET | `/api/dyrs/cdn/m3u8?id=&raw=` | CDN 二级列表（`raw=1` 为直链型） |
| GET | `/api/dyrs/cdn/ts?m3u8_id=&index=&uuid=` | 分片代理（自动跟随 302 到真实 TS），识别 PNG 占位图 |
| GET | `/api/dyrs/direct?id=&origin=` | 直链型列表：跟随 302 到真实 TS 主机，按最终地址把相对分片名补成绝对地址 |
| GET | `/api/dyrs/seg?u=<绝对地址>` | 真实 TS 直链透传（带 SSRF 校验，Content-Type 强制 `video/mp2t`） |
| GET | `/api/dyrs/site/home` | 影视仓首页：`banner` + `channels`（5 真实频道 + 3 预设）+ 各条推荐 `strips` |
| GET | `/api/dyrs/site/list?ch=&page=` | 分类列表。`ch` 接受 5 个真实频道（`dianying`/`dianshiju`/`zongyi`/`dongman`/`duanju`）**或 3 个预设**（`doc` 纪录片 / `bluray` 蓝光 / `us` 美剧）。筛选参数：`class` `area` `year` `sort_field` `line`（→ 上游 `origin`，即「只显示这条线路上有资源的片」）`ban`（文艺片）`exclude=his\|unlike`。预设入口**不分页**（上游带筛选翻页会丢筛选） |
| GET | `/api/dyrs/site/search?wd=` | 影视仓站内搜索 |
| GET | `/api/dyrs/site/img?id=&u=` | 影视仓封面图代理（上游要 Referer + 反爬校验，浏览器直连必 403） |
| GET | `/api/dyrs/site/drive?name=&imdb=` | 云盘分享源（上游 `/api/drive/list`） |
| GET | `/api/dyrs/site/detail?id=&kind=&ep=&origin=` | **影视仓详情**：不传 `origin` 会把**每条线路的选集都抓齐**（并发 3，缓存 10 分钟，带 `X-Cache`）并按「上游直接给真实 m3u8 的线路优先」排序；返回 `seq` + 每条线路的 `episodes[].src` |
| GET | `/api/dyrs/site/play?id=&kind=&seq=&p=&origin=` | 播放信息（JSON），`src` 即本站取流地址 |
| GET | `/api/dyrs/src?kind=&id=&seq=&p=&origin=` | **取流跳板**：302 到本站同源取流地址，给老播放器直接用 |
| GET | `/api/dyrs/site/flush` | 清空影视仓详情缓存（排查用） |

> 上游 CDN 默认 `https://box.dyrs.com.de`，可用环境变量 `DYRS_CDN` 覆盖。
>
> **注意 1**：CDN 型的 `/api/ts` 对未登录请求会返回微信二维码**占位图**，所以服务端会
> ①把 master 里 `&raw=1`（真 TS 直链）和 `/api/dyrs/direct` 排到最前，②**删掉**同 id 那条
> 必然返回占位图的清晰度，播放器侧再用 `startLevel: 0` 固定第一条。详见
> [`开发进展.md` 第十节](开发进展.md) / [第十二节](开发进展.md)。
>
> **注意 2**：上游镜像给 **HTML 页面**挂了一道 SHA1 工作量证明反爬，命中时返回
> HTTP **429** 的「正在检测」页（JSON 接口如 `/api/m3u8`、`/api/videox/least` 不受影响）。
> 服务端会自动解题并把全局有效的 `attack_key` 带上重放，所以对外不会看到 429。
> 详见 [`开发进展.md` 第十一节](开发进展.md)。
>
> **注意 3（选集寻址）**：上游的选集地址是 `/{kind}/{id}/{seq}.html?origin=线路&p=集序号`，
> `seq` 是 seqlist 编号（同一部片固定），`p` 是 **0 基**集序号。**不要**用
> `/{kind}/{id}/{N}.html` 那个 path 形式 —— 实测 N 和集数对不上，只会返回第一集。
> 详见 [`开发进展.md` 第十二节](开发进展.md)。
>
> **注意 4（必须 hls.js 优先）**：桌面 Chrome / Edge 的
> `video.canPlayType('application/vnd.apple.mpegurl')` 返回的是 **`'maybe'`**，
> 照抄「先判 canPlayType 再决定用原生 HLS」的写法，等于**永远不用 hls.js**。
> 而 Chrome 原生 HLS 只能吃最简形态，`/api/dyrs/*` 那条链（master → `cdn/m3u8?raw=1`
> → 每片带 `#EXT-X-DISCONTINUITY`）会直接 `video.error=4`：实测《嫁金钗》12 条线路
> 用原生时 8 条能播 / 1 条卡住 / 3 条全挂，换部片挂的又是另外几条。
> 所以 `pickHlsEngine()` 的顺序是 **hls.js → 原生（仅 Safari/iOS）→ 不支持**，单测锁着。
> 详见 [`开发进展.md` 第十七节](开发进展.md)。
>
> **注意 5（线路预检）**：`/api/dyrs/site/detail` 会给每条线路加 `alive` / `aliveState`
> （`ok` / `weak` / `dead`）。判 `dead` 的线路在详情页置灰标「暂不可用」但**仍可点** ——
> 预检是采样，上游 CDN（尤其 `vip1`）间歇性 502 会导致同一分钟里一会儿 dead 一会儿 ok。

### 为什么要拆成 list + covers 两步

采集站的 `ac=list` 接口**不返回封面和年份**（实测 `vod_pic` 就是空字符串），
只有 `ac=detail` 才有。但直接改用 detail 不可行：

| 接口 | 大小 | 耗时 | 封面 |
|---|---|---|---|
| `ac=list&t=6` | 5.6KB | 1.4s | 无 |
| `ac=detail&t=6`（电影） | 42KB | 2.7s | 有 |
| `ac=detail&t=13`（电视剧） | **109KB** | **33.7s** | 有 |
| `ac=detail&ids=<20个id>` | 42KB | 1~8s | 有 |

所以设计成：

1. 列表用 `ac=list`，快速返回先渲染
2. 前端渲染完再请求 `/api/covers`，用批量 `ids=` 补图和年份
3. 补图是异步的，**不阻塞首屏**；失败了也只是没图，不影响浏览

批量 `ids=` 只拉这一页的 20 条，不会像整个分类那样把全季播放地址都拖下来。

---

## 测试

```bash
npm run typecheck                      # 类型检查
npm test                               # 单元测试（235 个 / 16 文件）
node scripts/acceptance.mjs            # 端到端验收（22 项）
node scripts/source-probe.mjs --maccms <采集接口>   # 片源探测（加源前先跑这个）
node scripts/source-probe.mjs --wzzycc <模板站地址>  # 影视仓镜像探测
python scripts/browser-check.py        # 真实浏览器播放验证（首页/详情/播放）
python scripts/lines-check.py --id <视频id> --kind tv   # 逐线路播放回归（任何一条不能播退出码 1）
python scripts/browser-proxy-check.py  # 代理兜底路径验证
```

验收脚本需要服务已在运行。

---

## 目录结构

```
movie-player/
├── src/
│   ├── server.ts              # 入口，只绑 127.0.0.1
│   ├── config.ts              # 片源配置 + 频道规则 + 各类阈值（加源改这里）
│   ├── cache.ts               # LRU + TTL 缓存
│   ├── channels.ts            # 分类 → 频道归属（纯函数，有单测）
│   ├── facets.ts              # 多维筛选词表（地区/年份/语言）+ 归一（纯函数，有单测）
│   ├── parser.ts              # macCMS 字段解析（纯函数，有单测）
│   ├── proxy.ts               # 媒体/图片代理 + SSRF 防护
│   ├── store.ts               # 收藏/历史（JSON 原子写）
│   ├── updater.ts             # 一键更新：git 拉取覆盖 + npm install + 自愈重启
│   ├── localmedia.ts          # 本地目录扫描 / 安全路径 / 文件流（支持 Range）
│   ├── localdirs.ts           # 自定义目录入口（JSON 持久化）
│   ├── covers.ts              # 定位 ffmpeg/ffprobe + 抽帧封面 + 编码探测 + 文件体检
│   ├── playplan.ts            # 播放决策：直连 / mpegts / 转码（纯函数，有单测）
│   ├── transcode.ts           # 实时转码成 H.264 HLS（硬件优先 + 回退 + 回收）
│   ├── routes.ts              # API 路由
│   └── sources/
│       ├── types.ts           # 类型定义
│       ├── maccms.ts          # macCMS 采集站适配器
│       └── index.ts           # 多源聚合 + 故障转移 + 频道分组
├── public/                    # 前端（原生 JS，无构建步骤）
│   ├── index.html             # 搜索 / 频道 / 分类浏览
│   ├── detail.html            # 详情 + 线路 + 选集
│   ├── play.html              # 播放页
│   ├── local.html             # 本地媒体（飞牛影视风格海报墙 + 播放）
│   ├── local-ui.css           # 本地媒体的深色主题
│   ├── favorites.html  history.html
│   ├── app.js  player.js  player-ui.js  covers.js  facets.js  style.css
│   └── vendor/hls.min.js      # 本地引入，不依赖外部 CDN
├── scripts/                   # 验收 / 探测脚本（source-probe.mjs 用于加源前的健康探测）
├── test/                      # 单元测试
└── data/                      # 收藏/历史/封面缓存/转码产物（自动生成）
```

---

## 已知问题与处理

这些都是实测踩到的坑，代码里已经处理：

**1. 采集站分类 id 各站不同**
同一个 `t=1`，A 站是「电影片」只有 1 部，B 站又是别的。所以分类**不能硬编码**，代码里用 `discoverCategories()` 探测 1~40 号 id，按 `type_name` 归并，取条数最多的那个。结果缓存 6 小时。

**2. 采集站偶发返回被截断的 JSON**
HTTP 200，但 body 不完整（`ac=list` 尤其明显，实测 3 次里有 1 次）。解析会失败，代码里当作错误重试，不会把残缺数据当成正常响应。

**3. 各源 `vod_id` 会撞车（已修）**
`vod_id` 是各源自己的编号。`id=157040` 在量子资源是《兰香如故》，在无尽资源是另一部片。早期版本跨源按 id 兜底，会**静默返回错片子**。现在指定了源就只用那个源，并且用片名校验；要换源时按**片名**去搜，不按 id。

**4. 有些"线路"其实是网页分享页**
例如 `liangzi` 线给的是 `https://v.lzcdn27.com/share/xxx`，返回 65 字节的 HTML 外壳，真实地址要靠 JS 渲染，播放器拿不到。
代码里给每条线路加了 `playable` 标记（看地址是否含 `.m3u8`），详情页给这类线路标 ⚠，播放页会自动跳到可播的线路。

**5. `vod_play_from` 分隔符不统一**
`ac=detail` 里是 `$$$`，`ac=list` 里可能是逗号。解析器按 `$$$` 解析，`ac=list` 的 `vod_play_from` 本来就不用于播放，无影响。

**6. 代理有 SSRF 风险**
媒体代理是典型 SSRF 入口。代码里：只允许 http/https；解析域名后拒绝私有网段、回环、链路本地（含云元数据 `169.254.169.254`）；限流 + 并发上限。已用 6 个攻击向量实测全部拒绝。

**7. 片源域名会变**
采集站和 CDN 域名都会轮换，这是这类站的常态。所以**不要硬编码播放地址**，每次从接口取。多源配置就是为了这个。

**8. `ac=list` 不返回封面和年份（已修）**
这是「卡片没封面」的根因。`vod_pic` 和 `vod_year` 在 `ac=list` 里就是空字符串。
修法见上文「为什么要拆成 list + covers 两步」——不是改用 detail（剧集分类要 33 秒），而是列表先出、封面异步补。

**9. 补封面接口会抖动，超时不能卡住页面**
同一个 `ac=detail&ids=` 请求，实测 4.2s ~ 8s+ 不等。早期版本把它串在列表请求里，导致整页等 11 秒甚至超时失败。
现在：列表接口不碰封面，前端渲染完再异步补；超时放宽到 20s 并重试一次。

**10. 空结果不能进缓存（已修）**
上游超时时 `/api/covers` 返回空对象。如果缓存了这个空结果，接下来 30 分钟点哪里都没封面。
现在只有**非空结果**才写入缓存。

**11. 补封面必须用「列表实际返回的源」（已修）**
列表接口带故障转移：请求 lziapi，可能实际由 wujinapi 返回。而分类 id 各源不通用。
早期版本补封面时用的是「请求的源」，于是拿 A 站的 id 去 B 站查，一条都匹配不上，封面全空。
现在以列表**实际返回的 `source`** 为准。

**12. 含「剧」字的不一定是电视剧（单测抓到）**
按名称规则分类频道时，最初用「含剧 → 电视剧」，结果**喜剧片、剧情片被判成电视剧**，电影频道里混进了一堆片。
单测直接暴露了这个问题。现在改为：频道专有词先判，末尾用「以片结尾 / 以剧结尾」兜底。

**13. 首页不能阻塞在频道探测上**
首次 `/api/channels` 要做分类探测（几十个上游请求），早期版本先等它再加载列表，导致首页白屏很久。
现在按有无 `cat` 参数分流：带参数的直接加载列表，不带参数才等频道拿到默认分类，只加载一次。
另外加了渲染令牌，避免异步补封面的回调覆盖用户已经切换后的页面。

**14. 转码「一直在转却没画面」的元凶是字幕流（已修）**
电影 MKV 几乎都内封了 PGS/ASS 字幕，有些还有 3~4 条音轨。MPEG-TS 装不下 PGS 字幕，
ffmpeg 会直接报错退出——但前端只看到「转码中」，因为播放列表曾经出现过。
现在显式写死 `-map 0:v:0 -map 0:a:0? -sn -dn`，只取第一条视频 + 第一条音频、丢弃字幕与数据流，
并加 `-max_muxing_queue_size 2048`。

**15. 「检测文件」把无害告警当成文件损坏（已修）**
`[null @ ...] non monotonically increasing dts to muxer` 是 ffmpeg **输出端**的唠叨，
说明解码其实成功了（手机录制、拼接的片子常见）。早期逻辑「stderr 非空 = 损坏」把用户往重下文件的方向带。
现在改成**真解码两遍**（头 15 秒 + 尾 15 秒 `-sseof`，用 `-progress` 数真实帧数），
再用白/黑名单分级日志，认不出来的默认当提示，宁可漏报也不再误报。

**16. 「有 ffmpeg 不一定有 ffprobe」**
`@ffmpeg-installer` 只带 ffmpeg，系统最小化安装也常常只有 ffmpeg。
现在 `probeMedia()` 在拿不到 ffprobe 时会退化成 `ffmpeg -i 文件`（不给输出文件，毫秒级退出），
解析 stderr 里的流信息拿到编码 / 档次 / 像素格式 / 分辨率 / 时长。

**17. 硬件编码器「探测得到」不等于「真能用」**
QSV 需要 Intel 核显 + `/dev/dri`，NVENC 需要 NVIDIA 驱动。探测到编码器但运行时秒退很常见。
现在每个文件按「硬件档 → libx264」依次尝试，**只要一个分片都没产出就换下一档**，
并把坏掉的编码器记进黑名单，后面的文件直接跳过，不用每个文件都白等一次。

---

## 安全与使用边界

- 服务只绑 `127.0.0.1`，不对外监听
- 不含下载、批量抓取、转码、离线归档功能——它是一个播放器，不是资源库
- 数据（收藏/历史）只存在本机 `data/` 目录

片源为未授权影视内容，本工具定位为个人本地观看的播放器。请自行判断使用风险，不要公开部署或二次分发。

工具本身是内容中立的：`src/config.ts` 指向哪些源完全由你决定。
