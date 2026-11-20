#!/bin/bash
set -e
cd "$(dirname "$0")"

DEFAULT_TITLE="Kokona-Radio"
DEFAULT_SHORT="Kokona-Radio"
DEFAULT_DESC="在线网络电台"
DEFAULT_COLOR="#07070a"
DEFAULT_BG="#07070a"

FAVICON="/favicon-v1.png"
ICON192="/icon-192.png"
ICON512="/icon-512.png"

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
DESC=$(ask "描述" "$DEFAULT_DESC")
COLOR=$(ask "主题色-hex" "$DEFAULT_COLOR")
BG=$(ask "背景色-hex" "$DEFAULT_BG")

echo ""
echo "  审核："
echo "    标题      $TITLE"
echo "    简称      $SHORT"
echo "    描述      $DESC"
echo "    主题色    $COLOR"
echo "    背景色    $BG"
echo "    图标      $ICON192 / $ICON512"
echo ""

if ! confirm "写入 index.json / manifest.json?"; then
  echo "  已取消"
  exit 0
fi

for f in "icon-192.png" "icon-512.png" "favicon-v1.png"; do
  if [ ! -f "$f" ]; then
    echo "  ! 缺少 $f，PWA 图标会 404"
  fi
done

cat > index.json <<EOF
{
  "title": "$TITLE",
  "shortName": "$SHORT",
  "themeColor": "$COLOR",
  "icon": "$FAVICON"
}
EOF

cat > manifest.json <<EOF
{
  "id": "/",
  "name": "$TITLE",
  "short_name": "$SHORT",
  "description": "$DESC",
  "lang": "zh-CN",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "$BG",
  "theme_color": "$COLOR",
  "icons": [
    { "src": "$ICON192", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "$ICON512", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "$ICON512", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
EOF

if [ ! -f sw.js ]; then
  cat > sw.js <<'JSEOF'
self.addEventListener('install', function(e) { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) {});
JSEOF
  echo "  ! 未找到 sw.js"
fi

echo ""
echo "  已生成："
echo "    index.json"
echo "    manifest.json"
echo ""