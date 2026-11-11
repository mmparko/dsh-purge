---
name: fofa-recon
description: Batch asset reconnaissance via FOFA API (domains/IPs/ports/titles/fingerprints); rate-limited client with strict single-threading, minimum intervals, and exponential backoff to avoid 45012 errors
whenToUse: During reconnaissance phase when mapping out the internet-facing attack surface of an organization or domain
role: recon
enabled: true
---

# FOFA Asset Reconnaissance (Rate-Limited Safe Client)

## Credentials
- API Key: Read from environment variable `FOFA_KEY` (**never commit API keys to git**; all scripts in this skill read environment variables only).
- Endpoint: `GET https://fofa.info/api/v1/search/all`
- Parameters: `key`, `qbase64` (base64 encoded query), `size`, `page`, `fields`

## Official Rate Limits (Verified via fofa.info/vip)

| Tier | Monthly Queries | Monthly Data Points | **Query Concurrency** |
|---|---|---|---|
| Registered (Free) | No API (Web UI 300/mo) | Web UI 3,000/mo | — |
| Personal | 10,000/mo | 100,000/mo | **1 request / sec** |
| Professional | 80,000/mo | 800,000/mo | **1 request / sec** |
| Commercial | 900,000/mo | 9,000,000/mo | **2 requests / sec** |
| Enterprise V2 | 5,000,000/mo | 50,000,000/mo | **5 requests / sec** |

## Observed Rate-Limiting Behavior
- Rapid continuous requests -> **HTTP 429**, response body `{"error":true,"errmsg":"[45012] Request speed too fast"}`
- Invalid key -> HTTP 200 + `{"error":true,"errmsg":"[-700] Invalid account"}`
- Single-page `size` up to 1000 works normally; requests spaced >=1s consistently return 200.
- Conclusion: **Execute conservatively at 1 req/sec; strictly zero concurrency**; back off on 45012 errors without immediate retry.

## Operational Rules (Important)
1. **Prioritize specific queries**: Narrow scope using `domain=` / `cert=` / `org=` before using broad terms like `body=` / `title=`. Broad queries consume quota rapidly without actionable precision.
2. **Do not paginate exhaustively**: Fetch only the first 1-3 pages (100 items/page) to locate asset entry points.
3. **Single process, single thread**: Run only one collector task at a time; queue multiple queries sequentially.
4. **Cache results to disk**: Check `runs/fofa-*.jsonl` before querying to prevent duplicate requests.
5. **Run long tasks in background**: Use background execution rather than blocking chat interactions.
6. When quota is depleted or throttled, switch to alternative data sources (Certificate Transparency, DNS, search engines).

## Rate-Limited Client (Use this; avoid raw curl loops)
```bash
cat > runs/fofa_client.py <<'PY'
#!/usr/bin/env python3
"""FOFA Collector (Rate-Limited Safe): Single thread + min interval + exponential backoff + caching.

Usage:
  python3 runs/fofa_client.py 'domain="example.com"' --pages 2 --size 100 --interval 2.0
Output:
  runs/fofa-<slug>.jsonl   One JSON object per line {host,ip,port,title,domain,server,protocol}
"""
import argparse, base64, hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request

KEY = os.environ["FOFA_KEY"]
API = "https://fofa.info/api/v1/search/all"
FIELDS = "host,ip,port,title,domain,server,protocol"
RETRY_BACKOFF = [5, 15, 45]          # Backoff seconds when encountering 45012
HARD_BUDGET = 30                     # Max requests per execution


def fetch(query, page, size, timeout=30):
    qs = urllib.parse.urlencode({
        "key": KEY, "qbase64": base64.b64encode(query.encode()).decode(),
        "size": size, "page": page, "fields": FIELDS,
    })
    req = urllib.request.Request(API + "?" + qs, headers={"User-Agent": "redteam-recon/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"error": True, "errmsg": body[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--pages", type=int, default=2, help="Max pages (default 2)")
    ap.add_argument("--size", type=int, default=100, help="Items per page (default 100)")
    ap.add_argument("--interval", type=float, default=2.0, help="Min request interval seconds (default 2.0)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    slug = hashlib.md5(args.query.encode()).hexdigest()[:8]
    out = args.out or f"runs/fofa-{slug}.jsonl"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    if os.path.exists(out) and os.path.getsize(out) > 0:
        print(f"[cache] {out} exists ({os.path.getsize(out)} bytes); remove file to redownload", file=sys.stderr)
        return 0

    seen, rows, requests_made, last_ts = set(), [], 0, 0.0
    for page in range(1, args.pages + 1):
        wait = args.interval - (time.time() - last_ts)
        if wait > 0:
            time.sleep(wait)

        status, data = None, None
        for attempt, backoff in enumerate([0] + RETRY_BACKOFF):
            if attempt:
                print(f"[backoff] Waiting {backoff}s before retry (page={page})", file=sys.stderr)
                time.sleep(backoff)
            last_ts = time.time()
            requests_made += 1
            if requests_made > HARD_BUDGET:
                print(f"[stop] Reached hard budget {HARD_BUDGET}", file=sys.stderr)
                break
            status, data = fetch(args.query, page, args.size)
            if status == 200 and not data.get("error"):
                break
            errmsg = str(data.get("errmsg", ""))
            if "45012" in errmsg or status == 429:
                continue                      # Throttled -> backoff and retry
            print(f"[stop] Non-retryable error http={status} {errmsg}", file=sys.stderr)
            data = None
            break
        if data is None:
            break

        results = data.get("results") or []
        print(f"[page {page}] {len(results)} items (size={data.get('size')}, consumed_fpoint={data.get('consumed_fpoint')})", file=sys.stderr)
        for item in results:
            if isinstance(item, str):
                item = [item]
            host = item[0] if len(item) > 0 else ""
            ip = item[1] if len(item) > 1 else ""
            port = item[2] if len(item) > 2 else ""
            key = (host, ip, port)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "host": host, "ip": ip, "port": port,
                "title": item[3] if len(item) > 3 else "",
                "domain": item[4] if len(item) > 4 else "",
                "server": item[5] if len(item) > 5 else "",
                "protocol": item[6] if len(item) > 6 else "",
            })
        if len(results) < args.size:
            break

    with open(out, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"[done] {len(rows)} assets -> {out} ({requests_made} requests total)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
```

### Usage
```bash
mkdir -p runs
python3 runs/fofa_client.py 'domain="example.com"' --pages 2 --size 100 --interval 2.0
python3 runs/fofa_client.py 'cert="example.com"' --pages 3 --interval 2.0
python3 runs/fofa_client.py 'org="Example Corp"' --pages 2 --interval 2.0
```

### Database Logging Requirements
Read `runs/fofa-*.jsonl`, and record each item via `redteam_asset_add`: `provenance="passive"`, `tool="fofa"`, ports include `url=host`, `title`, `product=server`; domain names stored under `names`.

## Common Query Syntax
| Objective | Syntax |
|---|---|
| All assets under domain | `domain="example.com"` |
| Certificate matches domain | `cert="example.com"` |
| Specific CIDR subnet | `ip="203.0.113.0/24"` |
| Organization name | `org="Example Corp"` |
| Admin portal by title | `title="login" && domain="example.com"` |
| Body signature | `body="/seeyon/"` |
| Specific port | `ip="203.0.113.0/24" && port="3306"` |

> Note: Broad queries using `body=` or `title=` alone produce excessive results and exhaust quota quickly; always qualify with `domain=` or `ip=`.
