#!/bin/zsh
# Render <campaign>/upload/*.svg to small JPEG previews in <campaign>/preview (for viewing only, not for upload).
# Usage: generator/render.sh <campaignDir> [CODE ...]
set -e
C="$1"; shift
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$C/preview" "$C/.tmp"
while read -r code w h; do
  if [ $# -gt 0 ] && [[ ! " $* " == *" $code "* ]]; then continue; fi
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --user-data-dir="$C/.tmp/profile" --window-size=$w,$h \
    --screenshot="$C/.tmp/$code.png" "file://$C/upload/$code.svg" >/dev/null 2>&1
  sips -Z 2000 -s format jpeg -s formatOptions 88 "$C/.tmp/$code.png" --out "$C/preview/$code.jpg" >/dev/null
  rm -f "$C/.tmp/$code.png"
  echo "$code ${w}x${h} ok"
done < "$C/.sizes.txt"
rm -rf "$C/.tmp"
