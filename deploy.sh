#!/bin/bash
# 由「一键部署电影站.bat」自动上传并执行，不需要手改
cd "$(dirname "$0")" || exit 1

echo "----------------------------------------"
echo " 电影站在服务器上的启动过程"
echo "----------------------------------------"

if command -v docker >/dev/null 2>&1; then
  echo "[1/3] 发现 Docker，开始构建镜像（首次 2~5 分钟，别关窗口）"
  COMPOSE=""
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  fi
  if [ -n "$COMPOSE" ]; then
    $COMPOSE up -d --build
    RC=$?
    echo "----------------------------------------"
    docker ps --filter name=movie-player --format " 容器状态: {{.Status}}"
    if [ $RC -ne 0 ]; then
      echo " [X] 构建失败，把上面红色报错发给我"
      exit 1
    fi
    echo " 搞定：浏览器打开 http://服务器IP:8848"
    exit 0
  fi
  echo " 有 Docker 但没有 compose，直接构建"
  docker rm -f movie-player >/dev/null 2>&1
  docker build -t movie-player:latest . || { echo " [X] 构建失败"; exit 1; }
  docker run -d --name movie-player --restart unless-stopped \
    -p 8848:8848 -e HOST=0.0.0.0 -e PORT=8848 -e DATA_DIR=/app/data \
    -v "$PWD/data:/app/data" movie-player:latest
  echo " 搞定：浏览器打开 http://服务器IP:8848"
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  NODEV=$(node -v | tr -d 'v' | cut -d. -f1)
  echo "[1/3] 没有 Docker，但发现 Node $(node -v)"
  if [ "$NODEV" -ge 20 ] 2>/dev/null; then
    echo "[2/3] 安装依赖（只有 express，几十秒）"
    npm install --omit=dev --registry=https://registry.npmmirror.com --no-fund --no-audit
    echo "[3/3] 后台启动"
    pkill -f "node dist/server.js" >/dev/null 2>&1
    setsid nohup node dist/server.js > run.log 2>&1 &
    sleep 3
    tail -n 6 run.log 2>/dev/null
    echo " 搞定：浏览器打开 http://服务器IP:8848"
    exit 0
  fi
  echo " Node 版本太低（$(node -v)），需要 20 以上"
fi

echo ""
echo " [X] 这台服务器既没有 Docker，也没有 Node 20+"
echo " 解决：宝塔面板 -> 软件商店 -> 搜 Docker -> 安装（推荐）"
echo " 装好后再双击一次桌面上的「一键部署电影站.bat」就行"
exit 1
