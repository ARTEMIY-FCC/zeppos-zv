# Meme server

The example app needs a server because the phone side of a Zepp OS app has no
ffmpeg and cannot write files: the only way to get a file onto the watch is
"download a URL on the phone → transfer it". `server/app.py` fetches memes
from the public Coub API, encodes them with `encoder/zv.py` and serves the
`.zv` files.

## API

| Request | Response |
| --- | --- |
| `GET /v1/list?page=1&q=mid&seen=id1,id2` | `{items: [{id, title, dur, ready}], page, next}` — newest first, already encoded ones ahead, ids in `seen` left out |
| `GET /v1/prepare?id=<coub>&q=mid` | `{state: "work"\|"ready"\|"error", p, size, err}` — starts encoding if needed, `p` is progress in percent |
| `GET /v1/f/<coub>-<q>.zv` | the file |
| `GET /v1/health` | `{ok, version}` |

`q` is `low`, `mid` or `high` (see the presets in [ENCODING.md](ENCODING.md)).
Texts in `err` are shown on the watch and are in Russian.

## Behaviour

- **Sources:** Coub "Memes" community — fresh (pages 1–2), hot (pages 1–2)
  and random; checked every 10 minutes. Clips flagged NSFW, age-restricted,
  banned or with abuse reports are skipped. The first 12 seconds of the
  "share" version (video already muxed with its music) are used.
- **Catalog:** every discovered meme with its discovery time, plus the set of
  clips already served; stored in `CACHE/state.json`, entries older than a week
  are dropped.
- **Stock:** the server keeps about `POOL = 30` encoded clips that have not
  been served yet and tops the stock up every minute.
- **Queue:** `WORKERS = 3` encoder threads with priorities — a clip someone is
  waiting for (0), the next unencoded clips of a served list (1), warm-up (2).
- **Cache:** encoded files live for two days after their last download.

## Running

```bash
# locally (http://127.0.0.1:8791)
CACHE=/tmp/zvcache python3 server/app.py

# environment: PORT (8791), CACHE (/data in Docker), WORKERS (3),
# PUBLIC=1 to listen on all interfaces, NO_WARM=1 to disable discovery/warm-up
```

Docker deployment: `HOST=user@host SSH_PORT=22 server/deploy.sh` copies
`Dockerfile`, `app.py` and `encoder/zv.py`, builds the image and runs the
`zvideo` container bound to `127.0.0.1:8791` with the cache in `~/zvideo/cache`.
Expose it through a reverse proxy, or with `server/php/index.php` on a PHP host
(`https://<site>/zv/?p=/v1/list&page=1`). The proxy also undoes the double
URL encoding that Zepp on iOS applies to requests (`%2F` arrives as `%252F`).

Test the phone side against a server without a watch:

```bash
node tools/side-test.mjs http://127.0.0.1:8791
node tools/side-test.mjs "https://<site>/zv/?p="
```
