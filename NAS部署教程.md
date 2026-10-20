# 影视播放站 · NAS 部署教程（最新版）

> 飞牛 fnOS / 群晖 / 极空间等 Linux NAS 通用。三种方式挑一种，**推荐方式 A**（零安装，5 分钟）。

---

## 方式 A：NAS 运行包（推荐 · 不用装任何东西）

包内自带 Node.js 和依赖，NAS 上零安装。**上传的是 zip 压缩包**就照下面敲：

### 1. 解压

```sh
cd /vol1/1000/1                    # ← 改成你上传 zip 的目录
ls -l movie-player-nas.zip         # 确认 zip 在这里
unzip -o -q movie-player-nas.zip   # 解压出 nas-pack 文件夹
```

提示 `unzip: command not found` 就用：`python3 -m zipfile -e movie-player-nas.zip .`

解压后 `ls nas-pack` 应看到：`app  install-service.sh  node  start.sh  stop.sh  videos`

### 2. 启动（后台，关掉 SSH 不影响）

```sh
cd nas-pack
sh start.sh -d
```

看到 `✅ 已在后台启动` 即成功。**必须带 `-d`**——不加就是前台运行，SSH 一断服务就停。
浏览器打开 `http://192.168.1.10:8848`。

> 为什么：前台运行时服务与 SSH 窗口绑定，关窗口/断网/SSH 超时都会把服务带走。
> 加 `-d` 会用 `setsid + nohup` 把服务放到后台独立运行。

### 3. 开机自启 + 彻底常驻（强烈建议）

```sh
cd /vol1/1000/1/nas-pack
sh install-service.sh
```

有 sudo 装成 systemd 服务，没有权限自动退回 cron @reboot。
装完后：NAS 重启自动运行、SSH 断开不影响、不用手动启动。

管理命令：

```sh
systemctl status movie-player       # 看状态
sudo systemctl restart movie-player  # 重启
journalctl -u movie-player -f       # 看日志
sh restart.sh / sh stop.sh          # 没装服务时用这两个
```

> 如果你是把 `NAS运行包` **文件夹**直接传上去的（不是 zip），那就跳过第 1 步，直接 `sh /你的路径/NAS运行包/start.sh`。
> 压缩包用户的完整命令与报错对照表见《上传压缩包-启动命令.md》。

---

## 方式 B：Docker Compose

把项目目录拷到 NAS（如 `/vol1/1000/docker/movie-player`），编辑 `docker-compose.yml`：

```yaml
services:
  movie-player:
    build: .
    image: movie-player:latest
    container_name: movie-player
    restart: unless-stopped
    ports:
      - "8848:8848"
    environment:
      - HOST=0.0.0.0
      - PORT=8848
      - DATA_DIR=/app/data
      # 可选：本地视频目录（不用的话删掉这两行）
      - LOCAL_MEDIA_DIR=/media
    volumes:
      - ./data:/app/data
      # 可选：把 NAS 视频目录挂进容器
      - /vol1/1000/movies:/media
```

然后：

```bash
cd /vol1/1000/docker/movie-player
docker compose up -d --build
```

打开 `http://NAS的IP:8848`。

---

## 方式 C：源码方式（开发者 / 需要改代码）

```bash
cd /vol1/1000/docker/movie-player
npm install --omit=dev
npm run build
npm start          # 即 node dist/server.js
```

想更新版本：把新代码覆盖上去（**保留 `data/`**），然后 `npm install --omit=dev && npm run build`，再重启服务。

---

## 看 NAS 里自己存的电影（一步）

在播放站目录下建一个 `videos` 文件夹，把电影拷进去，**刷新网页**即可（顶栏「本地媒体」）。
不用改配置、不用重启。详见《本地媒体配置教程.md》。

想直接用已有的目录（如 `/vol1/1000/movies`），在服务文件里加一行：

```
Environment=LOCAL_MEDIA_DIR=/vol1/1000/movies
```

然后 `sudo systemctl daemon-reload && sudo systemctl restart movie-player`。

---

## 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址；只想 NAS 本机访问可设 `127.0.0.1` |
| `PORT` | `8848` | 监听端口 |
| `DATA_DIR` | 项目根 `data/` | 收藏 / 历史 / 分类缓存，务必持久化，别删 |
| `LOCAL_MEDIA_DIR` | 自动找 `videos` 文件夹 | 本地视频根目录（可选） |

---

## 这台服务有什么（最新功能）

- **11 个片源**聚合搜索：量子、无尽、非凡、暴风、天涯、360、闪电、红牛、魔都、金鹰、电影天堂
- **优酷/腾讯风格播放器**：缓冲进度条 + 时间气泡、倍速、音量、画中画、全屏、控制栏自动隐藏、双击全屏
- **广告自动剔除**：服务端清洗 m3u8，播放器内提示「已自动跳过 N 个广告片段」
- **跳过片头片尾**（标记一次同剧生效）+ 自动连播
- **断点续播 / 收藏 / 观看历史**
- **本地视频**：`videos` 文件夹即插即用
- 分类探测结果落盘缓存，**NAS 重启秒开首页**（首次启动需探测一次，约 1 分钟）

---

## 常见问题

**打不开 8848？**
1. 服务在跑吗：`systemctl status movie-player`，或 `tail -f run.log` 看日志
2. fnOS 防火墙放行 8848
3. 地址用 `http://` 不是 `https://`

**SSH 一关服务就停了？**
你用的是 `sh start.sh`（前台运行），服务和 SSH 窗口绑在一起。
改成后台运行即可：`sh start.sh -d`；想 NAS 重启也自动起就执行 `sh install-service.sh`。

**前台运行 vs 后台运行怎么区分？**
- `sh start.sh`：关掉 SSH 窗口 → 服务没了 ❌（仅调试用）
- `sh start.sh -d`：关掉 SSH 窗口 / 拔网线 → 服务照跑 ✅

**首次打开首页比较慢？**
第一次启动要探测 11 个源的分类（约 40~60 秒），之后结果会缓存 6 小时并落盘，重启后秒开。

**收藏/历史会不会丢？**
存在 `DATA_DIR`（默认 `app/data`）里，升级程序时保留该文件夹即可。

**某个片源挂了？**
不影响，会自动跳过（`/api/health` 可看各源状态）。片源域名这类站会经常换，后续版本会继续补充。

**只想本机访问？**
把 `Environment=HOST=0.0.0.0` 改成 `127.0.0.1` 后重启。

**安全提醒**
只建议在家庭局域网使用，不要把 8848 端口映射到公网。片源为网络公开采集接口，请自行判断使用边界。
