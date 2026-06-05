#!/usr/bin/env bash
# 给 electron-builder 产出的 .app 打 ad-hoc 签名。
# 我们没有 Apple Developer ID，但 Apple Silicon 不接受完全无签名的二进制，
# 这里用 `codesign --sign -` 做最小的本机可运行签名（不能在别的机器上通过 Gatekeeper，
# 第一次运行需要在「设置 → 隐私与安全性」点「仍要打开」）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/mac-arm64/rtunnel.app}"

if [[ ! -d "$APP" ]]; then
  echo "未找到 .app: $APP" >&2; exit 1
fi

xattr -cr "$APP" 2>/dev/null || true
# codesign 在 macOS 15+ 上会因 com.apple.provenance（SIP 系统属性，无法用户态清除）
# 抛出 "resource fork, Finder information, or similar detritus not allowed"，
# 但仍会写入有效的 ad-hoc 签名 —— 内核 `open` 路径接受这个签名，仅 `codesign --verify`
# 严格模式不通过。我们容忍这个 warning，只要 codesign -dv 能读出 adhoc 签名就算成功。
codesign --force --deep --sign - "$APP" 2>/dev/null || true
SIG_INFO=$(codesign -dv "$APP" 2>&1 || true)
if echo "$SIG_INFO" | grep -q "Signature=adhoc"; then
  echo "已签 (adhoc): $APP"
else
  echo "签名落地失败：" >&2
  echo "$SIG_INFO" >&2
  exit 1
fi
