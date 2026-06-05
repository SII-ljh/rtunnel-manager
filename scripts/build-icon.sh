#!/usr/bin/env bash
# 把 build/icon.svg 渲染成 build/icon.icns (macOS 完整 iconset)
# 依赖：macOS 自带 sips + iconutil + Google Chrome（用于 SVG → 高分辨率 PNG）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
SVG="$BUILD/icon.svg"
PNG1024="$BUILD/icon-1024.png"
ICONSET="$BUILD/icon.iconset"
ICNS="$BUILD/icon.icns"

if [[ ! -f "$SVG" ]]; then
  echo "缺少 $SVG" >&2; exit 1
fi

# 幂等：icns 已存在且比 svg 新就跳过（dist 流程不必每次都耗 chrome）。
# 强制重建：RT_REBUILD_ICON=1 npm run icon
if [[ -f "$ICNS" && "$ICNS" -nt "$SVG" && -z "${RT_REBUILD_ICON:-}" ]]; then
  echo "已有 ${ICNS}（且比 icon.svg 新），跳过。设 RT_REBUILD_ICON=1 可强制重建。"
  exit 0
fi

# 1) SVG → 1024×1024 PNG（chrome 渲染最忠实，无需 rsvg-convert / inkscape）
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "需要 Google Chrome 来把 SVG 渲染成 PNG（搜索路径: $CHROME）" >&2
  echo "可改用 rsvg-convert / inkscape 自行渲染并放置 $PNG1024" >&2
  exit 1
fi

# Chrome 截图会保存为 viewport 尺寸的 PNG。
# 用 data: URL 直接喂 SVG，避免临时 HTML 文件路径问题。
# 关键：window-size 跟 viewport 匹配 SVG，再把 SVG 设为 100% 宽高让它撑满。
SVG_B64=$(base64 -i "$SVG" | tr -d '\n')
HTML="<!doctype html><meta charset=utf-8><style>html,body{margin:0;padding:0;background:#fff}</style><img src='data:image/svg+xml;base64,$SVG_B64' width=1024 height=1024 style='display:block'>"
HTML_FILE="$BUILD/_icon-render.html"
printf '%s' "$HTML" > "$HTML_FILE"

USER_DIR=$(mktemp -d)
"$CHROME" --headless=new \
  --user-data-dir="$USER_DIR" \
  --hide-scrollbars --disable-gpu \
  --window-size=1024,1024 \
  --virtual-time-budget=1500 \
  --screenshot="$PNG1024" \
  "file://$HTML_FILE" >/dev/null 2>&1
rm -rf "$USER_DIR" "$HTML_FILE"

if [[ ! -f "$PNG1024" ]]; then
  echo "渲染 1024px PNG 失败" >&2; exit 1
fi

# 2) 用 sips 生成 macOS 完整 iconset 各尺寸
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for spec in \
  "16:icon_16x16.png" \
  "32:icon_16x16@2x.png" \
  "32:icon_32x32.png" \
  "64:icon_32x32@2x.png" \
  "128:icon_128x128.png" \
  "256:icon_128x128@2x.png" \
  "256:icon_256x256.png" \
  "512:icon_256x256@2x.png" \
  "512:icon_512x512.png" \
  "1024:icon_512x512@2x.png"; do
  size="${spec%%:*}"
  name="${spec##*:}"
  sips -z "$size" "$size" "$PNG1024" --out "$ICONSET/$name" >/dev/null
done

# 3) iconset → icns
iconutil -c icns "$ICONSET" -o "$ICNS"
echo "构建完成: $ICNS ($(du -h "$ICNS" | cut -f1))"
