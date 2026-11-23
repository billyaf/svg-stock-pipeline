#!/bin/zsh
# Build <campaign>/preview/_contact-sheet.png from preview JPEGs (6 columns).
set -e
C="$1"; T="$C/.sheet"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
rm -rf "$T"; mkdir -p "$T"
for f in "$C"/preview/[0-9A-E]*.jpg; do sips -Z 500 "$f" --out "$T/$(basename $f)" >/dev/null; done
{ echo '<html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(6,300px);gap:6px;padding:6px;font:14px sans-serif">'
  for f in "$T"/*.jpg; do n=$(basename $f .jpg); echo "<div><img src=\"$n.jpg\" style=\"width:300px;height:300px;object-fit:contain;background:#555\"><div style=\"font:11px sans-serif;white-space:nowrap;overflow:hidden\">$n</div></div>"; done
  echo '</body></html>'; } > "$T/sheet.html"
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --user-data-dir="$T/prof" --window-size=1848,1640 --screenshot="$C/preview/_contact-sheet.png" "file://$T/sheet.html" >/dev/null 2>&1
rm -rf "$T"
