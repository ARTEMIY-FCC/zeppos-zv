#!/usr/bin/env bash
# Build the demo clip bundled with the example app (watch/assets/*/demo.zv).
#
#   tools/make-demo.sh                 — a synthetic, license-free test clip (ffmpeg only)
#   tools/make-demo.sh my-video.mp4    — or any video of your own
#
# Needs ffmpeg and Python 3 with numpy and Pillow.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
src="${1:-}"
if [ -z "$src" ]; then
  src="$tmp/demo.mp4"
  # moving gradients + ffmpeg's test pattern (with a running timer) + a small tune
  ffmpeg -v error -y \
    -f lavfi -i "gradients=s=480x480:speed=0.03:n=4:rate=24,format=yuv420p[g];testsrc2=s=300x300:rate=24[t];[g][t]overlay=90:90" \
    -f lavfi -i "aevalsrc=0.2*sin(2*PI*(220+110*floor(2*t-4*floor(t/2)))*t)+0.08*sin(2*PI*660*t):s=32000:d=10" \
    -t 10 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$src"
fi
python3 encoder/zvcli.py "$src" "$tmp/demo.zv" --sec 10 --kbps 26
for t in watch/assets/*/; do cp "$tmp/demo.zv" "$t/demo.zv"; done
echo "demo.zv copied to watch/assets/*/"
