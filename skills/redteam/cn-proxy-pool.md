---
name: cn-proxy-pool
description: Free HTTP/SOCKS5 proxy pool: Harvest, validate, and rotate on-demand; command-level proxy flags only, never modify local host or proxy settings
whenToUse: When targets implement WAF/IP rate-limiting, or when high-frequency requests (endpoint fuzzing, directory brute force, password spraying) are required
role: vuln-scan
enabled: true
---

# Free IP Proxy Pool

Free proxies are inherently volatile; their objective is to **mitigate IP bans**, not to ensure anonymity. For critical objectives, prioritize dedicated egress VPS nodes or suo5 tunnels.

## ⛔ Strict Rule: Never Modify Local Host Network or Global Proxy Settings

Proxy flags must **only be passed as per-command arguments**. Never alter local system configurations. The following actions are strictly prohibited:

| Prohibited Action | Description |
|---|---|
| Set system proxies | GNOME/KDE desktop network settings, `gsettings set org.gnome.system.proxy ...`, `networksetup -setwebproxy`, Windows `netsh winhttp set proxy` |
| Set persistent environment variables | Modifying `http_proxy` / `https_proxy` / `all_proxy` / `no_proxy` in `/etc/environment`, `/etc/profile`, `/etc/profile.d/*`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.zshrc` |
| Modify global tool configs | Setting proxies in `~/.curlrc`, `~/.wgetrc`, `~/.npmrc`, `/etc/apt/apt.conf.d/*proxy*`, `/etc/pip.conf`, `~/.docker/config.json`, `~/.gitconfig` |
| Modify global proxychains configs | Editing `/etc/proxychains4.conf` or `~/.proxychains/proxychains.conf`; if necessary, use `-f` pointing to a temporary file in `runs/` and clean up immediately |
| Modify system networking | Modifying iptables/nftables rules, routing tables, DNS (`/etc/resolv.conf`), NetworkManager, or toggling VPN/tun interfaces |
| Persistent export | Do not run `export http_proxy=...` in interactive shell sessions; pass variables **inline** preceding the command |

**Sanctioned Usage** (Command-level, ephemeral only):

```bash
P=$(shuf -n1 runs/live-proxies.txt)

# Method 1: Native tool proxy flags (Preferred)
curl -s --proxy "http://$P" --max-time 15 -I "https://target.example.com/"
nuclei -u https://target.example.com/ -proxy "http://$P" -rate-limit 20
sqlmap -u "https://target.example.com/item?id=1" --proxy="http://$P" --batch --random-agent
ffuf -u https://target.example.com/api/FUZZ -w wordlist.txt -x "http://$P" -rate 20

# Method 2: Inline environment variables for single command (Expires with process)
http_proxy="http://$P" https_proxy="http://$P" curl -s --max-time 15 "https://target.example.com/"

# Method 3: Raw TCP tools -> use suo5 SOCKS5 tunnel (skill: suo5-tunnel);
#          use temporary proxychains config without altering system config:
proxychains4 -f runs/proxychains.tmp.conf -q nmap -sT -Pn -p 80,443 10.0.0.5
```

## 1. Harvest (Multi-Source Aggregation)
```bash
mkdir -p runs && cd runs
curl -s --max-time 20 "https://www.89ip.cn/tqdl.html?api=1&num=50&port=&address=%E4%B8%AD%E5%9B%BD&isp=" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{2,5}' >> raw-proxies.txt
curl -s --max-time 20 "http://www.ip3366.net/free/?stype=1" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}</td>[[:space:]]*<td>[0-9]{2,5}' \
  | sed -E 's#</td>[[:space:]]*<td>#:#' >> raw-proxies.txt
curl -s --max-time 20 "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/CN/data.txt" \
  | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{2,5}' >> raw-proxies.txt
sort -u raw-proxies.txt -o raw-proxies.txt && wc -l raw-proxies.txt
```

## 2. Validate (Concurrent Liveness Check)
```bash
cat > runs/check_proxy.py <<'PY'
import concurrent.futures, sys, urllib.request
TARGET = "http://www.baidu.com"   # Connectivity check only; carries no sensitive payload
def ok(proxy):
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://" + proxy, "https": "http://" + proxy}))
        with op.open(TARGET, timeout=6) as r:
            return proxy if r.status == 200 else None
    except Exception:
        return None
with open(sys.argv[1]) as f:
    cands = [l.strip() for l in f if l.strip()]
with concurrent.futures.ThreadPoolExecutor(max_workers=50) as ex:
    for res in ex.map(ok, cands):
        if res: print(res, flush=True)
PY
python3 runs/check_proxy.py runs/raw-proxies.txt > runs/live-proxies.txt
wc -l runs/live-proxies.txt
```

## 3. Rotation & Rate Limiting
- Pick a random proxy per request; automatically drop failing proxies and rotate to the next.
- Maintain target rate limits (`-rate-limit` / `--delay`); proxies rotate egress IPs but do not increase throughput.
- Track success/failure per egress IP; if a target blocks 3 consecutive requests, abandon the target per assessment rules.

## 4. Operational Notes
- **Never transmit credentials, session cookies, or uploaded shells over free proxies** — free proxies may log and intercept traffic.
- Liveness tests should only verify connectivity without sending application payloads.
- Before high-frequency brute forcing, verify target account lockout policies; pause before triggering lockouts.
- Remove temporary configuration files under `runs/` (e.g. `proxychains.tmp.conf`) when finished.
- Operate strictly within authorized engagement boundaries.
