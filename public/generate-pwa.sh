#!/bin/bash
set -e
cd "$(dirname "$0")"

DEFAULT_TITLE="Kokona-Radio"
DEFAULT_SHORT="Radio"
DEFAULT_COLOR="#07070a"
DEFAULT_ICON="/favicon-v1.png"
DEFAULT_BG="#07070a"

ask() {
  local prompt="$1"
  local def="$2"
  local var
  if [ -n "$def" ]; then
    read -r -p "$prompt [$def]: " var
  else
    read -r -p "$prompt: " var
  fi
  if [ -z "$var" ]; then
    var="$def"
  fi
  printf '%s' "$var"
}

confirm() {
  local ans
  read -r -p "$1 [Y/n]: " ans
  case "$ans" in
    n|N|no|NO|No) return 1 ;;
    *) return 0 ;;
  esac
}

echo ""
echo "  generate-pwa.sh"
echo "  ----------------"
echo ""

TITLE=$(ask "标题" "$DEFAULT_TITLE")
SHORT=$(ask "简称" "$DEFAULT_SHORT")
COLOR=$(ask "主题色-hex" "$DEFAULT_COLOR")
BG=$(ask "背景色-hex" "$DEFAULT_BG")
ICON=$(ask "图标路径(相对)" "$DEFAULT_ICON")

echo ""

ICON_FILE="${ICON#/}"
if [ -f "$ICON_FILE" ]; then
  ICON_STATUS="favicon存在"
else
  ICON_STATUS="favicon不存在${ICON}"
fi

echo "  审核："
echo "    标题      $TITLE"
echo "    简称      $SHORT"
echo "    主题色    $COLOR"
echo "    背景色    $BG"
echo "    图标      $ICON  ($ICON_STATUS)"
echo ""

if ! confirm "写入 index.json / manifest.json / sw.js?"; then
  echo "  已取消"
  exit 0
fi

cat > index.json <<EOF
{
  "title": "$TITLE",
  "shortName": "$SHORT",
  "themeColor": "$COLOR",
  "icon": "$ICON"
}
EOF

cat > manifest.json <<EOF
{
  "name": "$TITLE",
  "short_name": "$SHORT",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "$BG",
  "theme_color": "$COLOR",
  "icons": [
    { "src": "$ICON", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "$ICON", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
EOF

cat > sw.js <<'JSEOF'
self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) {});
JSEOF

echo ""
echo "  已生成："
echo "    index.json"
echo "    manifest.json"
echo "    sw.js"
echo ""
