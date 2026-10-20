# dyrs 体系（wzzycc 模板）CDN 接口情报

> 2026-10-12 实测抓取。用于在影视站复刻这套接口。

## 一、它是什么

`dyrs.me` 是个**跳转壳站**（307 → `dyrshd.net`），真实站点是一批**同模板镜像**，
模板目录 `/template/wzzycc/`，前端是服务端渲染。它**不是**标准 macCMS：

- 没有 `api.php/provide/vod/`（404）
- 自研 API 风格：路径 `/api/xxx`，返回 `{code:200, data:{...}}`
- 列表/搜索/详情是**服务端渲染的 HTML 页面**，没有 JSON 列表接口
- 只有**播放链路**是 JSON + m3u8 接口 ← **这就是「CDN 接口」**

## 二、线路发现

```
GET https://<任意镜像>/
        ↓ 页面 JS 调用
GET /api/videox/least
    → {"urls":["https://tvcang.com/","https://viprs2.cc/", ...共 34 条],
       "least":"https://tvcang.com/","sion_id":""}
```

兜底：`GET /hosts.html`，里面是 `var testUrlList = [...]`（另一份线路表）。

## 三、线路探活

```
GET {line}/api/ip
    → {"user":true,"flush":false,"ok":false,"expire_time":86400,
       "ip_id":"","Client":{},"AllOkTime":{},"ip":"124.236.243.147"}
```

判定可用：HTTP 200 且能解析出 `ip` 字段。前端就是拿它来「选最快线路」的。

## 四、播放链路（核心）

### 4.1 主接口

```
GET {line}/api/m3u8?origin={线路名 URL编码}&url={视频id}
    例：/api/m3u8?origin=%E8%B6%85%E7%BA%A7%E7%BA%BF%E8%B7%AF&url=6abe29565de7cbf1fe0d4aef
        （origin = 超级线路）
    → 302 Location: https://box.dyrs.com.de/api/super?id={视频id}&origin={线路名}
```

- 视频 id 是 24 位十六进制串
- `origin` 就是详情页上的线路名（如 `超级线路`、`王者TV蓝光`）
- **CDN 主机不在镜像站上**，而是独立域名（实测 `box.dyrs.com.de`），
  详情页里叫 `dyrs_api_origin` / `box_data.url`

### 4.2 CDN 主列表（master m3u8）

```
GET https://box.dyrs.com.de/api/super?id={id}&origin={线路名}
    → application/vnd.apple.mpegurl
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000
/api/m3u8?id={id}
#EXT-X-STREAM-INF:BANDWIDTH=900000
/api/m3u8?id={id}&raw=1
```

响应头带 `Access-Control-Allow-Origin: *`。

### 4.3 二级列表（media m3u8）

两种形态，**默认是代理型，`raw=1` 是直链型**：

```
GET https://box.dyrs.com.de/api/m3u8?id={id}          # 代理型（默认）
    → #EXTM3U / #EXT-X-VERSION:3 / PLAYLIST-TYPE:VOD / MEDIA-SEQUENCE:0
      / TARGETDURATION:8
      #EXTINF:4.000,
      /api/ts?m3u8_id={id}&index=0&uuid={uuid}
      ...

GET https://box.dyrs.com.de/api/m3u8?id={id}&raw=1    # 直链型
      #EXTINF:4.000,
      https://v.lzcdn28.com/20260905/15336_342c8938/2000k/hls/5d66baefec6000000.ts
      ...
```

- 分片地址是**相对路径**（代理型），要按 CDN 主机解析成绝对地址
- 会带 `#EXT-X-DISCONTINUITY`
- 直链型指向真实 TS CDN（如 `v.lzcdn28.com`）

### 4.4 分片

```
GET https://box.dyrs.com.de/api/ts?m3u8_id={id}&index={n}&uuid={uuid}
    → video/mp2t 二进制
```

- `uuid` 由二级列表接口下发的（每次请求可能不同，**必须用同一次拿到的 uuid**）
- index 从 0 开始

## 五、线路名 → 分类前缀（复刻导航用）

| 页面 | 路径 |
|---|---|
| 电影 | `/dianying.html` |
| 电视剧 | `/dianshiju.html` |
| 综艺 | `/zongyi.html` |
| 动漫 | `/dongman.html` |
| 短剧 | `/duanju.html` |
| 直播 | `/live.html` |
| 搜索 | `/search.html?wd=关键词` |
| 详情 | `/{movie\|tv\|zongyi}/{id}-{ep}.html` |

分类页支持 `?page=N&area=中国大陆&year=2026`。
详情页链接形如 `/tv/6a9b9cdc2dbbc2bdc9cda2c3-6039.html`
（`{24位id}-{集数}.html`）。

## 六、其它接口（非播放，供参考）

| 接口 | 说明 |
|---|---|
| `/api/app/version` | APP 版本信息 |
| `/api/user/login?istoken=1` | POST，登录态校验 |
| `/api/js/message?fp_id=` | 站内消息 |
| `/api/user/comment/count?video_id=` | 评论数 |
| `/api/session/flush?fp_id=` | 会话刷新 |
| `/api/code/get` | 验证码 |
| `/api/qrcode?url=` | 二维码 |

## 七、复刻要点（容易踩的坑）

1. **请求要带 Referer**（如 `Referer: https://tvcang.com/`），否则 CDN 可能拒绝。
2. `origin` 参数必须 **URL 编码**（中文线路名）。
3. 代理型二级列表里的 `/api/ts` 是**相对路径**，必须按 CDN 主机解析。
4. `uuid` 与 `m3u8_id` **成对使用**，不能跨次复用。
5. 镜像站会 302 跳转，抓取时要**跟随重定向**。
6. 线路表是**动态的**（34 条），不要硬编码，优先走 `/api/videox/least`。
7. **`/api/ts` 也是 302**，跳向真实 TS CDN（`v.lzcdn28.com/...ts`）。
   抓分片时必须 `redirect: follow`，只拿 302 的响应体会得到一段 `<a href=...>Found</a>` HTML。
8. **uuid 失效/不配对时上游不报错，而是静默返回一张 PNG 占位图**
   （实测 302 → `gimg1.baidu.com/...png`）。必须按魔数识别出来（PNG `89 50 4E 47`、
   GIF `47 49 46`、JPEG `FF D8`、HTML `3C`），否则播放器花屏/黑屏。

## 八、本站复刻实现与实测（`src/dyrs.ts` + `src/routes.ts`）

### 对外路由

| 路由 | 行为 |
| --- | --- |
| `GET /api/videox/least` | `{urls:[...],least,sion_id:''}`，10 分钟缓存，失败回落内置 20 条 |
| `GET /api/dyrs/ip?line=` | 探活，`{user,ok,expire_time,ip,ms,...}` |
| `GET /api/dyrs/fastest?n=` | 并发探活前 N 条线路，返回 `{ok,urls,best,ip,ms}` |
| `GET /api/dyrs/m3u8?origin=&url=` | **默认 302**（与原站一致）；`&proxy=1` 抓回重写直出 |
| `GET /api/dyrs/super?id=&origin=` | CDN 主列表（重写后） |
| `GET /api/dyrs/cdn/m3u8?id=&raw=` | CDN 二级列表（重写后） |
| `GET /api/dyrs/cdn/ts?m3u8_id=&index=&uuid=` | 分片代理（自动跟随 302 到真实 TS）+ 占位图识别 |
| `GET /api/dyrs/seg?u=<绝对地址>` | 真实 TS 直链透传，走 `checkUrl` 做 SSRF 校验 |

### 关键实现点

- `listLines(force)`：`/api/videox/least` → 34 条，10 分钟 TTL，失败回落 `FALLBACK_LINES`。
- `fetchUpstream`：统一带 `User-Agent` + `Referer`，`redirect` 可选 `follow`/`manual`，
  从 `res.headers.get('location')` 读跳转目标（**不是** `res.location`，那是 undefined）。
- `rewriteDyrsPlaylist(text, cdnBase, self)`：
  - `/api/ts?...` → `{self}/cdn/ts?...`
  - `/api/m3u8?id=` → `{self}/cdn/m3u8?id=`
  - 相对地址先按 `cdnBase` 补全
  - 其它绝对地址 → `{self}/seg?u=<encodeURIComponent(abs)>`
  - `#EXT-X-KEY` / `#EXT-X-MAP` 的 `URI="..."` 一并重写
- `looksLikePlaceholder(buf)`：魔数识别占位图，命中则路由返回 502 中文错误。
- `CDN_BASE = process.env.DYRS_CDN || 'https://box.dyrs.com.de'`，可用环境变量换 CDN。

### 实测记录（对上游真跑）

```
GET /api/videox/least           → 34 条镜像域名
GET /api/dyrs/ip?line=tvcang    → {"ok":true,"ip":"124.236.243.147","ms":184}
GET /api/dyrs/m3u8?...          → 302 Location: https://box.dyrs.com.de/api/super?id=...&origin=...
GET /api/dyrs/m3u8?...&proxy=1  → #EXTM3U / .../cdn/m3u8?id=... / .../cdn/m3u8?id=...&raw=1
GET /api/dyrs/cdn/m3u8?id=      → 重写为 /api/dyrs/cdn/ts?m3u8_id=&index=&uuid=
GET /api/dyrs/cdn/m3u8?id=&raw=1→ 重写为 /api/dyrs/seg?u=https%3A%2F%2Fv.lzcdn28.com%2F...ts
GET /api/dyrs/cdn/ts?...        → 200 video/mp2t 333700 字节，4740 1110 开头（有效 TS）
GET /api/dyrs/seg?u=...ts       → 200 video/mp2t 333700 字节，4740 1110 开头
GET /api/dyrs/seg?u=http://127.0.0.1... → 403 {"ok":false,"error":"拒绝对私有/回环地址的访问"}
```

（示例 id：`6abe29565de7cbf1fe0d4aef`，origin：`超级线路`，uuid：`6acbb6777257b47ef74ffdb0`）


---

## 补充：选集寻址与「能播的那条清晰度」（2026-10-12 实测，务必先看这段）

### 1. 选集地址：`{seq}` + `p`，不是路径里的集数

上游的选集/播放页地址是：

```
/{movie|tv|zongyi|duanju}/{id}/{seq}.html?origin={线路名}&p={集序号}   ← 选集（p 是 0 基）
/{movie|tv|zongyi|duanju}/{id}-{seq}.html?origin={线路名}              ← 线路 tab
```

- `seq` 是 **seqlist 编号**，同一部片固定、与线路无关（例：`33936`）。
  从页面里抓：优先 `/…-{seq}.html?origin=`（tab 形式），兜底 `/…/{seq}.html?origin=`。
  ⚠️ 不能随手匹配 `-(\d+)\.html`：详情页里还有个 `/…-1.html?ep_list=title` 的「标题模式」链接会先命中。
- `p` 是 **0 基**集序号：`p=0` → 第01集、`p=1` → 第02集。顺序和集标题都稳定（实测 lzm3u8 / 1080zyk）。
- ⛔ **不要**用 `/{kind}/{id}/{N}.html` 这个 path 形式：实测 `N` 与集数对不上，
  `N=2`/`N=3` 还会返回第 01 集（等于选集点了没反应）。

**一次抓够一条线路的选集**：播放页里除了当前集，还带 `next[]`（后续**全部**剧集），
所以抓 `p=0` 就够 —— 实测 52 集的短剧一次 `next` 就全拿到了。

### 2. 选集是「按 origin 服务端渲染」的

详情页 `/{kind}/{id}-1.html` **不传 `origin`** 时，只有**当前线路**的 seqlist 会渲染，
其它线路在 tab 上只有名字和集数徽标。所以想拿到「线路切换」的完整矩阵，
必须**逐条线路**抓 `?origin=X`。传了 `origin` 的那一条才会带真选集。

### 3. master 里能播的是 `&raw=1`，`/api/direct` 往往是幌子

实测 master 更常见是：

```
#EXT-X-STREAM-INF:BANDWIDTH=1000000
/api/m3u8?id=xxx            ← 分片走 CDN /api/ts → 未登录时静默返回 PNG 占位图（约 624KB）✗
#EXT-X-STREAM-INF:BANDWIDTH=900000
/api/m3u8?id=xxx&raw=1      ← 真 TS 直链：https://v.lzcdn27.com/…/xxx.ts（magic 47401110）✓
```

而 `/api/direct?id=&origin=` 实测**不是**直链型：它 302 回 `/api/m3u8?id=&origin=`。
所以「把 direct 提到最前」只对部分片源有效；正确做法是**按需可用性排序**：

`direct`(0) → `…/cdn/m3u8?…&raw=1`(1) → 其余(2)，并且**删掉**同 id 那条不带 `raw` 的
（它只会返回占位图）。对应 `src/dyrs.ts` 的 `hoistPlayableVariants()`。

### 4. 线路要按「上游给的是不是真实 m3u8」排序

同一部片的线路分两类（实测 10 条里 7 条是前者）：

| 类型 | 线路名样例 | 播放页里的 `url` | 本站链路 |
| --- | --- | --- | --- |
| **direct** | `lzm3u8` `1080zyk` `modum3u8` `bfzym3u8` `dyttm3u8` `ffm3u8` `jsm3u8` | 绝对地址 `https://v.lzcdn27.com/…/index.m3u8` | `/api/proxy?url=`（顺带广告剔除） |
| **dyrs** | `超级线路` `王者TV加速` `wztv` | `/api/m3u8?origin=…&url=…` | `/api/dyrs/m3u8?proxy=1&…`（靠 `raw=1`） |

→ `direct` 的排前面（快、稳、自带广告过滤）；`dyrs` 的放后面兜底。

### 5. 新增/变更的对外接口

```
GET /api/dyrs/site/detail?id=&kind=&ep=&origin=
    不传 origin：逐条线路抓齐选集（并发 3），按 direct 优先排序，缓存 10 分钟（X-Cache: hit|miss）
    返回 { ok, detail: { …meta, seq, origins:[{ origin, count, kind, episodes:[{p,title,origin,src}] }] } }
    传 origin：只要这一条，快路径。
GET /api/dyrs/site/play?id=&kind=&seq=&p=&origin=   → { ok, src, origin, title, next }
GET /api/dyrs/src?kind=&id=&seq=&p=&origin=         → 302 到本站同源取流地址（给播放器直接用）
GET /api/dyrs/site/flush                            → 清空详情缓存
```
