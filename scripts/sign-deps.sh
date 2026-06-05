#!/usr/bin/env bash
# macOS Sequoia 起，未签名的 Mach-O 二进制会被内核 SIGKILL（exit 137）。
# 这是给 electron-builder 用的「helper 修复」：node_modules 里的辅助二进制
# （app-builder / 7za / 各种 *.node）会被 npm install 解包成无签名状态，
# 直接调用就 EXEC_FAILED。这里给它们都打一遍 ad-hoc 签名。
#
# 触发：`npm run sign:deps`（或在 `dist` 之前自动跑一次）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "node_modules 不存在，先 npm install" >&2; exit 1
fi

count=0
while IFS= read -r f; do
  if file "$f" 2>/dev/null | grep -q "Mach-O"; then
    xattr -c "$f" 2>/dev/null || true
    codesign --force --sign - "$f" >/dev/null 2>&1 || {
      echo "签名失败: $f" >&2; continue;
    }
    count=$((count + 1))
  fi
done < <(find node_modules -type f \( -name "*.node" -o -path "*/mac/*" -o -path "*/darwin*/*" \) 2>/dev/null)

echo "已签 $count 个 helper 二进制"
