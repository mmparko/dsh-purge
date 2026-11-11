---
name: dir-bruteforce
description: Directory and file bruteforce: Admin portals, backups, config disclosure, source code, and repository exposure (ffuf/feroxbuster/dirsearch/gobuster)
whenToUse: When a web service is verified live but fingerprints provide no direct 1day/Nday clues; needed to find hidden paths, admin portals, backups, configs, source repos, and upload points
role: vuln-scan
enabled: true
---

# Directory and File Bruteforce (Primary Entrypoint Discovery)

**In practice, most initial access entrypoints stem from directory fuzzing rather than complex CVE exploits**: admin panels (`/admin`), backup archives (`www.zip`), configurations (`.env`), repositories (`.git/`), API docs (`swagger-ui.html`), upload endpoints, debug interfaces, and actuator/druid monitoring consoles.
This skill leverages four pre-installed tools. **Do not rely on just one** — their dictionaries and heuristic logic complement each other.

## Local Tools

| Tool | Path | Version | Highlights |
| --- | --- | --- | --- |
| **feroxbuster** | `/usr/bin/feroxbuster` | 2.13.1 | Rust-based, premier recursive fuzzing with auto directory traversal (**Preferred**) |
| **ffuf** | `/usr/bin/ffuf` | 2.1.0-dev | Fast, highly flexible, supports multi-dictionary, vhosts, parameter fuzzing |
| **dirsearch** | `$DSH_HOME/redteam/toolkit/dirsearch/dirsearch` | v0.5.0 | Python. Place manually if needed |
| **gobuster** | `/usr/bin/gobuster` | — | Lightweight and stable; dir/dns/vhost modes |

## 1. feroxbuster (Preferred: Recursive + Dynamic Filter)

```bash
feroxbuster -u https://target.example.com \
  -w /usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt \
  -x php,asp,aspx,jsp,html,js,zip,tar.gz,bak,sql,txt,xml,json,config \
  -d 3 -t 30 --rate-limit 80 --timeout 10 \
  --filter-status 404 --filter-size 0 \
  -o runs/ferox-target.txt --json -o runs/ferox-target.json
```

Key points: Limit `-d 3` (recursion depth); use `--rate-limit` to prevent target overload; include backup and configuration extensions in `-x`.

## 2. ffuf (Fast, Multi-Dict / vhost / Parameters)

```bash
# Directories & Files (Two rounds: directories first, then extensions on hits)
ffuf -u https://target/FUZZ -w /usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt \
  -mc 200,204,301,302,307,401,403,500 -fc 404 -t 40 -rate 80 -timeout 10 \
  -o runs/ffuf-dir.json -of json

# Sensitive Files (Backups, configs, source, secrets)
ffuf -u https://target/FUZZ -w /usr/share/seclists/Discovery/Web-Content/quickhits.txt \
  -mc all -fc 404 -t 40 -o runs/ffuf-quick.json -of json

# Virtual Host Discovery (Multi-tenant sites on shared IP)
ffuf -u https://target/ -H "Host: FUZZ.example.com" \
  -w /usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt \
  -fs 0 -mc all -t 50 -o runs/ffuf-vhost.json -of json
```

## 3. dirsearch (Rich dictionaries, supplemental coverage)

```bash
$DSH_HOME/redteam/toolkit/dirsearch/dirsearch \
  -u https://target.example.com -e php,asp,aspx,jsp,zip,bak,txt,sql,json \
  --random-agent -t 30 --delay 0.1 --exclude-status 404 \
  -r -R 3 --format json -o runs/dirsearch-target.json
```

## 4. gobuster (Lightweight fallback)

```bash
gobuster dir -u https://target -w /usr/share/seclists/Discovery/Web-Content/common.txt \
  -x php,asp,aspx,jsp,zip,bak -t 30 -k -o runs/gobuster-target.txt
```

## Wordlists (Pre-installed)

| Purpose | Path |
| --- | --- |
| Large Directories | `/usr/share/seclists/Discovery/Web-Content/raft-large-directories.txt` |
| Medium Directories | `/usr/share/seclists/Discovery/Web-Content/raft-medium-directories.txt` |
| Common Files | `/usr/share/seclists/Discovery/Web-Content/common.txt` |
| Sensitive Files (quickhits) | `/usr/share/seclists/Discovery/Web-Content/quickhits.txt` |
| Subdomains (for vhost) | `/usr/share/seclists/Discovery/DNS/subdomains-top1million-20000.txt` |

Wordlist roots: `/usr/share/seclists`, `/usr/share/wordlists`. **When dictionaries are insufficient**, build targeted wordlists from organization names and abbreviations collected via `redteam_credential_list`.

## High-Value Findings (Follow through immediately)

| Hit | Next Step |
| --- | --- |
| `/admin`, `/manage`, `/login`, Portal paths | Route to Credential Attack: Default/weak passwords (skill `credential-attack`) |
| `.git/`, `.svn/`, `.env`, `config.php.bak`, `www.zip`, `web.rar` | **Source & Config Disclosure**: Download and extract DB connection strings, API keys, hardcoded credentials -> `redteam_credential_add` |
| `swagger-ui.html`, `/v2/api-docs`, `/openapi.json` | Extract full endpoint inventory -> Unauthorized access / IDOR probing (skill `unauth-exploit`) |
| `actuator`, `druid`, `/console`, `/jmx` | Unauthorized monitoring dashboards; frequently lead directly to RCE or DB dumps |
| Upload endpoints, import, backup restore, template/report designers | Route to Exploitation role to chain webshell upload |
| `.ssh/`, `id_rsa`, `*.pem`, `*.jks` | Private key leak -> Attempt direct authentication (`ssh -i`) |

## Noise Reduction & Safety

1. **Filter soft 404s**: Request a random non-existent path first; check status code and response length to calibrate `--filter-size` / `-fs`.
2. **Throttle requests**: Start with `-rate 80` / `--delay 0.1` / `-t 30`; if encountering WAF blocks (403/429), reduce to 5-10 req/s.
3. **Avoid destructive endpoints**: Never bruteforce state-changing endpoints like `/logout`, `/reboot`, `/shutdown`, `/delete*`, `/reset*`. Exclude them if present in wordlists.
4. **Abandon after >3 bans**: Mark asset as abandoned (`redteam_asset_test` with `status=abandoned` and `blocked=true`) and move to the next target.
5. **Intranet targets via tunnel**: feroxbuster `--proxy socks5://127.0.0.1:1080`, ffuf `-x socks5://127.0.0.1:1080` (skill `suo5-tunnel`).

## Database Logging Requirements (Mandatory)

1. **Hidden paths are not score points themselves, but all valuable discoveries must be recorded**:
   - Discovered portals / upload points / API docs -> Append to `surface` via `redteam_asset_test` for downstream vulnerability assessment;
   - Leaked source code / configs / keys / credentials -> Record via `redteam_credential_add` (`source=config disclosure`, command and path in `tool`, plaintext in `secret_value`);
   - Unauthorized endpoints / monitoring consoles -> Record directly via `redteam_vuln_add` (with `evidence` response) + `redteam_http_evidence_add`.
2. **Log key milestones in `redteam_chain_add`**: `stage_code=internet` (or `internal`), `tool` with full command, and `result` summarizing hits (e.g. `Found /admin/, /backup/www.zip, /.env`).
3. Update `redteam_asset_test` immediately upon completion (`status`, `test`, `surface`) to prevent redundant scans by subsequent agents.
4. Save wordlists and output logs under `runs/` for report reproducibility.
