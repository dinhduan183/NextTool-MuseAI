#!/usr/bin/env bash
# Đóng gói bản Windows có kèm sẵn Node.js (portable) để máy Windows không cần cài Node.js.
# Chạy trên macOS/Linux:  bash scripts/build-windows.sh  [phiên bản Node, mặc định = LTS mới nhất]
# Kết quả: dist/NextTool-MuseAI-Windows-v<version>.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_VER="$(node -p "require('./package.json').version")"
NODE_VER="${1:-$(curl -fsSL https://nodejs.org/dist/index.json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log(JSON.parse(s).find((r) => r.lts).version);
  });')}"
NODE_PKG="node-${NODE_VER}-win-x64"
NAME="NextTool-MuseAI-Windows-v${APP_VER}"

CACHE="$ROOT/dist/.cache"
STAGE="$ROOT/dist/$NAME"
OUT="$ROOT/dist/$NAME.zip"
mkdir -p "$CACHE"

echo "Bản tool: v$APP_VER  |  Node.js: $NODE_VER (win-x64)"

# 1. Tải Node.js portable cho Windows (có cache) và kiểm tra SHA256
if [ ! -f "$CACHE/$NODE_PKG.zip" ]; then
  echo "Đang tải $NODE_PKG.zip ..."
  curl -fL --progress-bar -o "$CACHE/$NODE_PKG.zip.part" "https://nodejs.org/dist/$NODE_VER/$NODE_PKG.zip"
  mv "$CACHE/$NODE_PKG.zip.part" "$CACHE/$NODE_PKG.zip"
fi
EXPECTED="$(curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | awk -v f="$NODE_PKG.zip" '$2 == f { print $1 }')"
ACTUAL="$(shasum -a 256 "$CACHE/$NODE_PKG.zip" | awk '{ print $1 }')"
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Lỗi: SHA256 của $NODE_PKG.zip không khớp. Xoá $CACHE/$NODE_PKG.zip rồi chạy lại." >&2
  exit 1
fi

# 2. Lấy code đã commit (không lấy data/, output/, node_modules/)
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
if [ -n "$(git status --porcelain)" ]; then
  echo "Cảnh báo: có thay đổi chưa commit — bản đóng gói chỉ lấy code đã commit (HEAD)."
fi
git archive HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/scripts" "$STAGE/.gitignore" "$STAGE/.gitattributes"

# 3. Giải nén Node.js vào thư mục node\
unzip -q "$CACHE/$NODE_PKG.zip" -d "$CACHE/unzip"
mv "$CACHE/unzip/$NODE_PKG" "$STAGE/node"
rm -rf "$CACHE/unzip"

# 4. Nén thành file zip
(cd "$ROOT/dist" && zip -qry "$NAME.zip" "$NAME")
rm -rf "$STAGE"

echo "Xong: $OUT ($(du -h "$OUT" | cut -f1))"
