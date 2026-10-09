#!/usr/bin/env python3
"""Meme server for the watch app: Coub feed → .zv videos (see encoder/zv.py).

    GET /v1/list?page=1&q=mid&seen=a,b → {items: [{id, title, dur, ready}], page, next}
    GET /v1/prepare?id=<coub>&q=mid    → {state: work|ready|error, p, size, err}
    GET /v1/f/<coub>-<q>.zv            → the file for the watch
    GET /v1/health

The feed is the public Coub API (no key): the "Memes" community — fresh, hot
and random. NSFW / age-restricted / moderated clips are dropped. Every time the
watch gets what it has not seen yet (seen), newest and already encoded first.
A coub is a short loop with music; the "share" version (video already muxed
with sound) is used, first MAX_SECONDS seconds.

Encoded files stay in the cache for two days. The server keeps a stock of POOL
encoded clips that have not been served yet and refills it as they are watched.
Messages in "err" are shown on the watch, so they are in Russian.
"""
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "encoder"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zv  # noqa: E402

PORT = int(os.environ.get("PORT", "8791"))
CACHE = os.environ.get("CACHE", os.path.join(tempfile.gettempdir(), "zvcache"))
KEEP = 2 * 24 * 3600
MAX_SECONDS = 12
MAX_SOURCE = 40 * 1024 * 1024
VERSION = "1"  # bump when the format or encoder settings change: the old cache becomes invalid
COUB = "https://coub.com/api/v2/timeline/"
# Where new memes come from (Memes community): fresh, hot, random
SOURCES = ["community/memes/fresh?page=1", "hot/memes?page=1", "hot/memes?page=2",
           "community/memes/fresh?page=2", "random/memes?page=1"]
PAGE = 20
POOL = 30  # encoded clips not yet served that the server keeps in stock
UA = "Mozilla/5.0 (zeppos-video)"

# Quality: frames per second and video kilobytes per second (sound adds 4 KB/s)
QUALITY = {
    "low": dict(fps=10, kbps=9),
    "mid": dict(fps=12, kbps=15),
    "high": dict(fps=12, kbps=26),
}
SIZE = 240  # row stride; the picture is 239x240, scaled 2x on the watch

WORKERS = int(os.environ.get("WORKERS", "3"))
DISCOVER_EVERY = 10 * 60  # look for new memes every 10 minutes
WARM_EVERY = 60  # top up the stock every minute

jobs = {}
lock = threading.Lock()
# job queue: (priority, sequence, key). 0 — a person is waiting, 1 — next in the
# feed, 2 — warm-up. A key may be queued twice — the second entry is skipped
tasks = queue.PriorityQueue()
seq = [0]
meta = {}  # id → feed info (where to download from)
# Catalog: everything seen in the Coub feeds, by discovery time (newest last).
# served — clips already sent to a watch. Stored in the cache, survives restarts
catalog = {}  # id → {title, dur, url, t}
served = set()
state_dirty = [False]


class Fail(Exception):
    """An error with a human-readable text: it is shown on the watch."""


def log(*a):
    print(" ".join([time.strftime("%Y-%m-%d %H:%M:%S")] + [str(x) for x in a]), flush=True)


def http_get(url, limit=None, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if limit is None:
            return r.read()
        data = r.read(limit + 1)
        if len(data) > limit:
            raise Fail("Ролик слишком большой")
        return data


def safe(c):
    """No NSFW, age-restricted or banned clips."""
    return not (c.get("not_safe_for_work") or c.get("age_restricted") or c.get("age_restricted_by_admin")
                or c.get("banned") or c.get("abuses"))


def source_url(c):
    fv = c.get("file_versions") or {}
    share = (fv.get("share") or {}).get("default")
    if share:
        return share
    h5 = (fv.get("html5") or {}).get("video") or {}
    for q in ("med", "high", "higher"):
        if (h5.get(q) or {}).get("url"):
            return h5[q]["url"]
    return None


def coubs_from(path):
    """Clips of one Coub feed page: safe ones with a video only."""
    data = json.loads(http_get(COUB + path + "&per_page=" + str(PAGE)))
    out = []
    for c in data.get("coubs") or []:
        cid = str(c.get("permalink") or "")
        if not safe(c) or not source_url(c) or not re.fullmatch(r"[A-Za-z0-9]{3,20}", cid):
            continue
        meta[cid] = {"url": source_url(c), "title": c.get("title") or ""}
        out.append({"id": cid, "title": (c.get("title") or "")[:80], "url": source_url(c),
                    "dur": round(min(float(c.get("duration") or MAX_SECONDS), MAX_SECONDS), 1)})
    return out


def discover():
    """Walk the sources and add new memes to the catalog."""
    now = time.time()
    added = 0
    for src in SOURCES:
        try:
            items = coubs_from(src)
        except Exception as e:  # noqa: BLE001
            log("feed", src, repr(e))
            continue
        with lock:
            for it in items:
                if it["id"] not in catalog:
                    catalog[it["id"]] = dict(it, t=now)
                    added += 1
        now -= 0.001  # within one pass keep the source order
    if added:
        state_dirty[0] = True
        log("new memes", added, "total", len(catalog))


def ready(cid, q):
    return os.path.exists(path_of(cid, q))


def listing(q, seen, page):
    """
    Feed for the watch: newest first, encoded ones ahead (they are delivered
    right away), already seen by the watch (seen) — dropped.
    """
    with lock:
        ids = [c for c in catalog if c not in seen]
    ids.sort(key=lambda c: catalog[c]["t"], reverse=True)
    rd = [c for c in ids if ready(c, q)]
    rest = [c for c in ids if not ready(c, q)]
    order = rd + rest
    chunk = order[(page - 1) * PAGE:page * PAGE]
    items = [{"id": c, "title": catalog[c]["title"], "dur": catalog[c]["dur"], "ready": ready(c, q)} for c in chunk]
    return {"items": items, "page": page, "next": page + 1 if len(order) > page * PAGE else 0}


def load_state():
    try:
        with open(os.path.join(CACHE, "state.json")) as f:
            st = json.load(f)
        catalog.update(st.get("catalog") or {})
        served.update(st.get("served") or [])
        for cid, c in catalog.items():
            meta.setdefault(cid, {"url": c.get("url"), "title": c.get("title", "")})
        log("catalog", len(catalog), "served", len(served))
    except (OSError, ValueError):
        pass


def save_state():
    with lock:
        # drop catalog entries older than a week: their files are gone anyway
        old = time.time() - 7 * 24 * 3600
        for cid in [c for c, v in catalog.items() if v["t"] < old]:
            del catalog[cid]
        st = {"catalog": catalog, "served": sorted(served & set(catalog))}
        state_dirty[0] = False
    tmp = os.path.join(CACHE, "state.json.part")
    with open(tmp, "w") as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(tmp, os.path.join(CACHE, "state.json"))


def coub_meta(cid):
    if cid in meta:
        return meta[cid]
    c = json.loads(http_get(f"https://coub.com/api/v2/coubs/{cid}"))
    if not safe(c):
        raise Fail("Этот ролик недоступен")
    url = source_url(c)
    if not url:
        raise Fail("У ролика нет видео")
    meta[cid] = {"url": url, "title": c.get("title") or ""}
    return meta[cid]


def path_of(cid, q):
    return os.path.join(CACHE, f"{cid}-{q}-v{VERSION}.zv")


def encode_job(key, cid, q):
    job = jobs[key]
    tmp = None
    try:
        m = coub_meta(cid)
        job["p"] = 5
        data = http_get(m["url"], limit=MAX_SOURCE, timeout=60)
        fd, tmp = tempfile.mkstemp(suffix=".mp4")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        job["p"] = 10
        preset = QUALITY[q]
        frames = zv.read_frames(tmp, SIZE - 1, SIZE, preset["fps"], MAX_SECONDS)
        if len(frames) < 2:
            raise Fail("Не получилось прочитать видео")
        audio = zv.read_audio_mp3(tmp, len(frames) / preset["fps"])
        enc = zv.Encoder(SIZE, SIZE)

        def progress(i, n):
            job["p"] = 10 + int(85 * i / n)

        t0 = time.time()
        blob, _, _ = enc.encode(frames, preset["fps"], audio, log=progress, kbps=preset["kbps"])
        out = path_of(cid, q)
        with open(out + ".part", "wb") as f:
            f.write(blob)
        os.replace(out + ".part", out)
        job.update(state="ready", p=100, size=len(blob))
        log("done", cid, q, len(frames), "frames", len(blob), "bytes", f"{time.time() - t0:.1f} s")
    except Fail as e:
        job.update(state="error", err=str(e))
        log("error", cid, q, e)
    except Exception as e:  # noqa: BLE001
        job.update(state="error", err="Не получилось сжать видео")
        log("crash", cid, q, repr(e))
        traceback.print_exc()
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


def prepare(cid, q, prio=0):
    key = f"{cid}-{q}"
    out = path_of(cid, q)
    if os.path.exists(out):
        return {"state": "ready", "p": 100, "size": os.path.getsize(out)}
    with lock:
        job = jobs.get(key)
        if job is None or job["state"] == "error" and time.time() - job["at"] > 60:
            job = jobs[key] = {"state": "work", "p": 0, "at": time.time(), "prio": prio, "started": False}
            seq[0] += 1
            tasks.put((prio, seq[0], key, cid, q))
        elif job["state"] == "work" and not job["started"] and prio < job["prio"]:
            # a person now waits for a warm-up job — move it to the front
            job["prio"] = prio
            seq[0] += 1
            tasks.put((prio, seq[0], key, cid, q))
    return {k: job[k] for k in ("state", "p", "size", "err") if k in job}


def worker():
    while True:
        prio, _, key, cid, q = tasks.get()
        with lock:
            job = jobs.get(key)
            if not job or job["state"] != "work" or job["started"]:
                continue
            job["started"] = True
        encode_job(key, cid, q)


def prefetch(items, q="mid"):
    """The first unencoded items of a served feed jump the warm-up queue: they are shown next."""
    n = 0
    for it in items:
        if n >= 4:
            break
        if not it.get("ready"):
            prepare(it["id"], q, prio=1)
            n += 1


def warmer():
    """
    Stock of encoded memes: new ones are discovered every 10 minutes and as many
    are encoded as needed to keep about POOL unserved clips ready. When someone
    watches them, the stock is topped up.
    """
    last = 0
    while True:
        try:
            if time.time() - last > DISCOVER_EVERY:
                last = time.time()
                discover()
            with lock:
                ids = sorted(catalog, key=lambda c: catalog[c]["t"], reverse=True)
                busy = sum(1 for j in jobs.values() if j["state"] == "work")
            stock = sum(1 for c in ids if c not in served and ready(c, "mid"))
            need = POOL - stock - busy
            for c in ids:
                if need <= 0:
                    break
                if c in served or ready(c, "mid") or f"{c}-mid" in jobs and jobs[f"{c}-mid"]["state"] != "error":
                    continue
                prepare(c, "mid", prio=2)
                need -= 1
            if state_dirty[0]:
                save_state()
        except Exception as e:  # noqa: BLE001
            log("warm-up", repr(e))
        time.sleep(WARM_EVERY)


def cleanup():
    while True:
        try:
            now = time.time()
            for name in os.listdir(CACHE):
                p = os.path.join(CACHE, name)
                if now - os.path.getmtime(p) > KEEP:
                    os.remove(p)
        except OSError:
            pass
        time.sleep(3600)


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # the phone side service in the Zepp simulator is a browser page: fetch needs CORS
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = dict(urllib.parse.parse_qsl(u.query))
        try:
            if u.path == "/v1/health":
                return self.send(200, {"ok": True, "version": VERSION})
            if u.path == "/v1/list":
                page = max(1, min(100, int(qs.get("page", "1") or 1)))
                q = qs.get("q", "mid") if qs.get("q") in QUALITY else "mid"
                seen = set(x for x in qs.get("seen", "").split(",") if x)
                if not catalog:
                    discover()
                out = listing(q, seen, page)
                prefetch(out["items"], q)
                return self.send(200, out)
            if u.path == "/v1/prepare":
                cid = qs.get("id", "")
                q = qs.get("q", "mid")
                if not re.fullmatch(r"[A-Za-z0-9]{3,20}", cid) or q not in QUALITY:
                    return self.send(400, {"state": "error", "err": "Неверный запрос"})
                return self.send(200, prepare(cid, q))
            m = re.fullmatch(r"/v1/f/([A-Za-z0-9]{3,20})-(low|mid|high)\.zv", u.path)
            if m:
                p = path_of(m.group(1), m.group(2))
                if not os.path.exists(p):
                    return self.send(404, {"err": "Ещё не готово"})
                os.utime(p)
                with lock:
                    if m.group(1) not in served:
                        served.add(m.group(1))
                        state_dirty[0] = True
                with open(p, "rb") as f:
                    return self.send(200, f.read(), "application/octet-stream")
            return self.send(404, {"err": "Не найдено"})
        except Fail as e:
            return self.send(502, {"state": "error", "err": str(e)})
        except Exception as e:  # noqa: BLE001
            log("request", self.path, repr(e))
            return self.send(500, {"state": "error", "err": "Сервер не смог ответить"})

    def log_message(self, fmt, *args):
        pass


def main():
    os.makedirs(CACHE, exist_ok=True)
    load_state()
    threading.Thread(target=cleanup, daemon=True).start()
    for _ in range(WORKERS):
        threading.Thread(target=worker, daemon=True).start()
    if not os.environ.get("NO_WARM"):
        threading.Thread(target=warmer, daemon=True).start()
    log("listening", PORT, "cache", CACHE)
    ThreadingHTTPServer(("0.0.0.0" if os.environ.get("PUBLIC") else "127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
