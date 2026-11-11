---
name: active-scan
description: Active port and service scanning (nmap/masscan), strictly within authorized scope
whenToUse: When verifying asset liveness and open ports
role: recon
enabled: true
---

## Pre-checks
1. Verify target CIDR is within authorized scope.
2. Confirm active scanning is permitted during the current timeframe.

## Commands
- Quick liveness: `nmap -sn <cidr>`
- All ports (rate-limited): `nmap -sS -p- --min-rate 1000 -T4 <target> -oX runs/nmap-full.xml`
- Service versions: `nmap -sV -sC -p <ports> <target> -oX runs/nmap-svc.xml`

## Available Toolkit Binaries (Absolute paths, prioritize these over ad-hoc scripts)
| Purpose | Command |
| --- | --- |
| Port scanning | `nmap` / `masscan` / `~/.dsh/redteam/toolkit/naabu/naabu` (SYN requires root; otherwise add `-scan-type c`) |
| Comprehensive intranet scan | `~/.dsh/redteam/toolkit/fscan/fscan` (skill: fscan-intranet) |
| Intranet surveying / fingerprinting | `~/.dsh/redteam/toolkit/gogo/gogo` (skill: gogo-intranet) |
| HTTP probing (ProjectDiscovery) | `~/.local/bin/pd-httpx` (**Note: `/usr/bin/httpx` is Python httpx CLI, not this**) |
| Subdomain / DNS | `~/.dsh/redteam/toolkit/subfinder/subfinder`, `~/.dsh/redteam/toolkit/dnsx/dnsx` |
| POC scanning | `nuclei` (templates located at `~/.local/nuclei-templates`) |
| Directory bruteforce | `ffuf`, `~/.dsh/redteam/toolkit/dirsearch/dirsearch` |
| Tunnels | `~/.dsh/redteam/toolkit/suo5/suo5-linux-amd64`, `toolkit/chisel/chisel`, `toolkit/frp/{frpc,frps}` |

## Database Logging Requirements
Record with provenance = `active`, tool = `nmap`/`masscan`, and record scan_run.
