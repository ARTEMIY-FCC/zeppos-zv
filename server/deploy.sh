#!/usr/bin/env bash
# Deploy the meme server: build the image and restart the container.
#   HOST=user@host SSH_PORT=22 ./server/deploy.sh
# The container listens on 127.0.0.1:8791 only — expose it via a proxy (php/index.php or nginx).
set -euo pipefail
HOST="${HOST:?set HOST=user@host}"
SSH_PORT="${SSH_PORT:-22}"
DIR=zvideo
cd "$(dirname "$0")"
ssh -p "$SSH_PORT" "$HOST" "mkdir -p ~/$DIR/cache"
scp -q -P "$SSH_PORT" Dockerfile app.py ../encoder/zv.py "$HOST:~/$DIR/"
ssh -p "$SSH_PORT" "$HOST" "cd ~/$DIR && docker build -q -t zvideo . && (docker rm -f zvideo >/dev/null 2>&1 || true) && docker run -d --name zvideo --restart unless-stopped --cpus 6 -p 127.0.0.1:8791:8791 -v ~/$DIR/cache:/data zvideo && sleep 2 && curl -s 127.0.0.1:8791/v1/health"
