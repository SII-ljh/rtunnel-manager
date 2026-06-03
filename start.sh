#!/usr/bin/env bash
# 后台常驻启动 rtunnel 管理器（脱离终端）。
# 用法: ./start.sh        然后浏览器打开 http://127.0.0.1:7070
#      RT_MANAGER_PORT=8090 ./start.sh   换端口
set -e
cd "$(dirname "$0")"

PORT="${RT_MANAGER_PORT:-7070}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，管理器可能已在运行：http://127.0.0.1:$PORT"
  exit 0
fi

# 数据 / 日志写到本机的 Library 下，避免 iCloud 同步把 pid/状态串到别的设备。
DATA_DIR="$HOME/Library/Application Support/rtunnel-manager"
mkdir -p "$DATA_DIR"
LOG="$DATA_DIR/manager.log"
nohup env RT_MANAGER_PORT="$PORT" node server.js >>"$LOG" 2>&1 &
disown 2>/dev/null || true
sleep 0.6
echo "rtunnel 管理器已在后台启动: http://127.0.0.1:$PORT"
echo "日志: $LOG"
