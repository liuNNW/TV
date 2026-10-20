#!/usr/bin/env bash
# PM2 一键部署 / 更新脚本（Linux 服务器、NAS）
#
# 首次部署：
#   bash scripts/pm2-deploy.sh
#
# 手动更新（Web 一键更新不可用时的 SSH 兜底）：
#   bash scripts/pm2-deploy.sh --update
#
# 可选环境变量：HOST、PORT、DATA_DIR、BRANCH（--update 时用）、PM2_APP_NAME（默认 movie-player）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="${PM2_APP_NAME:-movie-player}"
MODE="${1:-deploy}"

say() { printf '\n==> %s\n' "$1"; }
die() { printf '\n[X] %s\n' "$1" >&2; exit 1; }

# ---------- 环境检查 ----------
say "检查运行环境"
command -v node >/dev/null 2>&1 || die "没有找到 node，请先安装 Node.js 20+"
command -v npm  >/dev/null 2>&1 || die "没有找到 npm"
command -v git  >/dev/null 2>&1 || die "没有找到 git（apt install git 或 NAS 套件里安装）"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node 版本太低（$(node -v)），需要 20 以上"
fi
printf '    Node %s / npm %s\n' "$(node -v)" "$(npm -v)"

if ! command -v pm2 >/dev/null 2>&1; then
  say "安装 PM2（全局）"
  npm install -g pm2 --no-audit --no-fund || die "PM2 安装失败；权限不足请先执行 sudo npm install -g pm2"
else
  printf '    PM2 %s\n' "$(pm2 -v)"
fi

# ---------- 更新代码（仅 --update） ----------
if [ "$MODE" = "--update" ] || [ "$MODE" = "update" ]; then
  say "拉取远程最新代码"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "当前目录不是 git 仓库，无法 --update"

  BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)}"
  [ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] || BRANCH="main"

  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
  printf '    已更新到 origin/%s\n' "$BRANCH"
fi

# ---------- 安装依赖 + 构建 ----------
say "安装依赖（构建需要 devDependencies）"
npm install --no-audit --no-fund

say "构建 dist/（TypeScript → JavaScript）"
npm run build

say "清理开发依赖，只保留运行依赖"
npm prune --omit=dev --no-audit --no-fund

# ---------- PM2 启动 / 重载 ----------
say "交给 PM2 托管"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

# ---------- 结果 ----------
PORT_SHOW="${PORT:-8848}"
HOST_SHOW="${HOST:-0.0.0.0}"
if [ "$HOST_SHOW" = "0.0.0.0" ]; then
  HOST_SHOW="服务器IP"
fi

cat <<EOF

✅ 部署完成

   访问地址：http://${HOST_SHOW}:${PORT_SHOW}
   进程状态：pm2 status
   查看日志：pm2 logs ${APP_NAME}
   重启服务：pm2 restart ${APP_NAME}

   开机自启（只需执行一次，需要 sudo）：
     pm2 startup
     pm2 save

   提示：如果 8848 被旧的 node/nohup 进程占用，先停掉旧进程再执行本脚本。
EOF
