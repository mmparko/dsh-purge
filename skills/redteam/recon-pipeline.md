---
name: recon-pipeline
description: ProjectDiscovery reconnaissance pipeline: subfinder -> dnsx -> naabu -> httpx -> katana to systematically map out domain attack surfaces
whenToUse: During reconnaissance after obtaining domain or organization names, to systematically map subdomains -> DNS resolution -> ports -> web liveness -> endpoints
role: recon
enabled: true
---

# External Reconnaissance Pipeline (ProjectDiscovery)

Converting a root domain into an actionable inventory of live hosts with titles, technology stacks, and open ports is the standard reconnaissance workflow.
The tools follow a **strict sequence**: Enumerate subdomains -> Resolve DNS -> Scan ports -> Verify web liveness -> Crawl pages and API endpoints.

## Local Toolkit Binaries

| Tool | Path | Version | Purpose |
| --- | --- | --- | --- |
| subfinder | `$DSH_HOME/redteam/toolkit/subfinder/subfinder` | v2.16.0 | Passive subdomain enumeration (multi-source aggregation) |
| dnsx | `$DSH_HOME/redteam/toolkit/dnsx/dnsx` | v1.3.1 | DNS resolution, bruteforce, wildcard filtering |
| naabu | `$DSH_HOME/redteam/toolkit/naabu/naabu` | v2.6.1 | Fast port scanning (SYN requires root; otherwise `-scan-type c`) |
| httpx | `$DSH_HOME/redteam/toolkit/httpx/httpx` (wrapper: `~/.local/bin/pd-httpx`) | v1.12.0 | HTTP liveness / titles / tech stack / status codes |
| katana | (Use skill `browser-automation` if needed) | — | Crawler for pages and endpoints |
| ksubdomain | `$DSH_HOME/redteam/toolkit/ksubdomain/ksubdomain` | v0.7 | Stateless subdomain bruteforce (faster than dnsx bruteforce) |
| OneForAll | `$DSH_HOME/redteam/toolkit/oneforall/OneForAll-0.4.5/` (source with `.venv`) | v0.4.5 | Comprehensive subdomain collection suite |

> ⚠️ **`/usr/bin/httpx` is the Python httpx library CLI, not ProjectDiscovery's** — always use `pd-httpx` or the absolute path.

## Standard Pipeline

```bash
mkdir -p runs
TK=$DSH_HOME/redteam/toolkit
D=example.com

# 1. Subdomain Enumeration (Passive, multi-source)
$TK/subfinder/subfinder -d $D -all -silent -o runs/subfinder-$D.txt
# Optional: Stateless bruteforce (when wordlist is available)
# $TK/ksubdomain/ksubdomain -d $D -f /usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt

# 2. Wildcard DNS Filtering & Resolution (dnsx filters wildcard noise)
cat runs/subfinder-$D.txt | $TK/dnsx/dnsx -silent -a -resp -o runs/dnsx-$D.txt
awk '{print $1}' runs/dnsx-$D.txt | sort -u > runs/alive-domains-$D.txt

# 3. Port Scanning (Fast top-100 scan first, followed by full ports on live hosts)
$TK/naabu/naabu -l runs/alive-domains-$D.txt -top-ports 100 -silent -o runs/naabu-$D.txt
# Full ports (slower; confirm authorization first): -p - -rate 1000

# 4. HTTP Liveness & Tech Fingerprinting (Titles / Status / Tech Stack / Server)
$TK/httpx/httpx -l runs/alive-domains-$D.txt -ports 80,443,8080,8443,8000,8888,9000 \
  -title -status-code -tech-detect -web-server -follow-redirects -silent \
  -json -o runs/httpx-$D.jsonl

# 5. Compile into Asset Inventory (Live URLs for dir bruteforce & vuln scanning)
python3 - <<'PY'
import json
out=set()
for line in open('runs/httpx-'+'$D'+'.jsonl'):
    try: j=json.loads(line)
    except: continue
    if j.get('url'): out.add(j['url'])
open('runs/alive-urls.txt','w').write('\n'.join(sorted(out)))
print('Live URLs:', len(out))
PY
```

## Quick Commands (Stand-alone Tasks)

```bash
# Subdomains only
$TK/subfinder/subfinder -d example.com -all -silent

# Live URLs only (from existing domains list)
pd-httpx -l domains.txt -silent -o alive.txt

# Port scan single host (all ports)
nmap -sS -p- --min-rate 1000 -T4 1.2.3.4 -oX runs/nmap-1.2.3.4.xml   # skill: active-scan
$TK/naabu/naabu -host 1.2.3.4 -p - -rate 1000 -silent
```

## Role & Skill Division

| Scenario | Recommended Skill |
| --- | --- |
| Org name / root domain -> Full attack surface (unindexed, subsidiaries) | **`fofa-recon`** (Broadest asset coverage) |
| Domain -> Subdomains -> Liveness -> Fingerprints | **`recon-pipeline`** (Standardized pipeline) |
| Passive recon without touching target | `passive-recon` (crt.sh / dig / whois) |
| Intranet subnet surveying | `gogo-intranet` (**Do not use this skill for intranet**) |
| SPA / JavaScript-heavy rendering, endpoint discovery | `browser-automation` / `kimi-webbridge` |
| Live host ports & service versions | `active-scan` (nmap / masscan) |

**Recommended Flow**: `fofa-recon` for overall perimeter map -> `recon-pipeline` on discovered domains for live hosts -> `active-scan` on priority targets for exact versions.

## Operational Rules

1. **Strictly within scope**: Naabu full-port scans and ksubdomain bruteforce are **active** operations; verify authorization.
2. **Rate limiting**: Start with `naabu -rate 1000`; `subfinder` is quieter when used with passive sources without `-all`.
3. **Wildcard DNS**: `dnsx` filters wildcard entries automatically; if results show random subdomains on identical IPs, use `-wd` or update dictionary.
4. **API keys (optional)**: Configure `~/.config/subfinder/provider-config.yaml` to integrate Shodan / Censys / VirusTotal (see skill `redteam-setup`).

## Database Logging Requirements (Mandatory)

1. **Record each finding via `redteam_asset_add`**: `target` (domain/IP), `names` (domains), `ports` (with `url=host`, `title`, `product=server`), `provenance=passive` (for subfinder/dnsx) or `active` (for naabu/httpx), and `tool`.
2. **Auto-generate /24 CIDRs** (handled automatically by `redteam_asset_add`) -> link relationships via `redteam_asset_link`: `resolves` (domain -> IP), `contains` (CIDR -> IP) (see skill `asset-correlation`).
3. **Log pipeline milestones via `redteam_chain_add`**: `stage_code=recon`, `tool` with exact command executed, and `result` summarizing counts (e.g. `subfinder found 42 subdomains -> dnsx resolved 31 live -> naabu found 87 open ports -> httpx identified 19 live web services`).
4. **Highlight perimeter assets**: Test/staging environments (test/dev/uat/pre/staging), legacy software, non-standard ports, and unindexed hosts on shared CIDRs — record these in `note` as high-priority targets for assessment.
5. **Report clear numbers to Commander**: Subdomains count / Live IPs / Open ports / Live web applications / High-priority candidate targets.
