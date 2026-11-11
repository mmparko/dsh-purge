---
name: nuclei-scan
description: "nuclei template-based vulnerability scanner: 13,000+ templates covering CVEs, exposures, misconfigurations, and default credentials; primary detection engine for N-day and 1-day vulnerabilities"
whenToUse: "During vulnerability discovery once alive assets are identified, executing batch N-day/1-day scans or verifying specific component versions against established templates"
role: vuln-scan
enabled: true
---

# nuclei (Template-Based Vulnerability Detection)

`nuclei` is the **core workhorse** for vulnerability discovery: a single CLI command tests for CVEs, exposures, configuration flaws, default credentials, and unauthorized access points.
The local template library is fully provisioned; **do not fetch external POCs from the web when templates already exist**.

## Local Binary & Templates

| Item | Value |
| --- | --- |
| Binary | `/usr/bin/nuclei` (v3.11.1) |
| Template Repository | `~/.local/nuclei-templates` (**13,742 templates**) |
| Template Release | v10.4.9 |
| Configuration Files | `~/.config/nuclei/config.yaml`, `.templates-config.json` |

Template Distribution: `http/` 11,364 (including `http/cves` 4,320, `http/misconfiguration` 981, `http/vulnerabilities` 961, `http/exposures` 707, `http/default-logins` 307), `cloud/` 663, `file/` 447, `network/` 282, `dast/` 251.

**Template Updates**: `nuclei -update-templates` (run no more frequently than once per week; always verify with `-tl` after updating).

## Standard Invocations

```bash
# 1) Single target rapid assessment (evaluates what templates match without aggressive testing)
nuclei -u https://target.example.com -severity critical,high,medium -rl 30 -c 15

# 2) Batch scan across verified alive URLs exported from asset inventory
nuclei -l runs/alive-urls.txt -severity critical,high -rl 50 -c 25 \
  -jsonl -o runs/nuclei-$(date +%m%d-%H%M).jsonl

# 3) Targeted template execution (known component version -> surgical check with high accuracy and low noise)
nuclei -u http://target:8080 -t http/cves/2021/CVE-2021-44228.yaml
nuclei -u http://target -t http/exposures/ -t http/default-logins/

# 4) Tag-filtered batch sweep
nuclei -l runs/alive-urls.txt -tags seeyon,weaver,panel,exposure -rl 20

# 5) Dry-run template list (evaluates template coverage without sending network packets)
nuclei -l runs/alive-urls.txt -tags cve -tl
```

## Key Flags (Operational Recommendations)

| Flag | Purpose | Recommended Value |
| --- | --- | --- |
| `-rl` | Max requests per second | Internet perimeter: 30–50; lower to 5 if WAF triggers |
| `-c` | Concurrent templates | 15–25; excessive concurrency can destabilize small web servers |
| `-severity` | Filter template severity | Focus strictly on `critical,high` (low/medium findings generally do not earn engagement points) |
| `-tags` / `-t` | Filter templates | Prioritize based on confirmed fingerprints rather than scanning blind |
| `-jsonl -o` | Structured output | **Must be saved under `runs/`** for reporting and evidence |
| `-proxy` | Route through proxy | Use `cn-proxy-pool` for perimeter evasion; **use `-proxy socks5://127.0.0.1:1080` for internal targets** |
| `-H` | Custom HTTP headers | Pass authenticated session cookies/tokens |
| `-duc` | Disable update check | Speeds up execution in batch sweeps |
| `-stats -si 30` | Progress interval | Monitor status during extended batch runs |

## Coordination with Knowledge Base (Search First, Avoid Duplication)

Prior to active testing, invoke `redteam_poc_search` (filtering by CVE / component / version / body text signature) — it queries two layers in a single pass: **the local custom POC knowledge base + the local nuclei template repository**.
If a match is found, retrieve full contents via `redteam_poc_get` or execute directly via `nuclei -t <template>`. Search online only if both local layers yield no results.

When new custom templates or exploit scripts are verified, record them into the knowledge base using `redteam_poc_add` (specifying `category`, `engagement`, `asset_target`, `verified=true`, and a sanitized `verified_note`).

## Operational Discipline & Protection

1. **Default Ignore Excludes Destructive Templates**: `~/.config/nuclei/.nuclei-ignore` excludes tags such as `dos`, `local`, `fuzz`, `bruteforce`, and `txt-service`.
   **Do NOT remove these exclusions**; DoS templates can crash production systems and disrupt active engagements.
2. **Recon Before Firing**: Execute initial passes with `-severity critical,high`; investigate confirmed matches individually rather than bombarding assets indiscriminately.
3. **WAF & Rate-Limiting Responses**: If blocked, drop `-rl` to 5, add `--delay 1s`, rotate User-Agent headers, or pivot egress via `cn-proxy-pool`.
   **If an asset triggers access blocks > 3 times, immediately abandon testing on that target** (`redteam_asset_test` status=abandoned, blocked=true) and shift to alternative targets.
4. **Production Peak Hour Awareness**: Exercise caution with templates triggering heavy database operations or sync jobs against production targets.

## Output & Ledger Registration (Mandatory)

Ingest scan results immediately upon completion; **do not defer until engagement wrap-up**:

1. Ingest `runs/nuclei-*.jsonl`, executing `redteam_vuln_add` for each finding:
   - `title` (template name + matched location), `severity`, `cve` (from template `classification.cve-id`), `target` (**including port**),
     `evidence` (response excerpt / matching signature / matched-at), `confidence=confirmed`,
     `gained` (capability provided upon exploitation), `agent=vuln-scan`.
2. **Attach Evidence via `redteam_http_evidence_add`** for every confirmed vulnerability: request line + Host header + essential parameters + response body excerpt (the template's `curl-command` field can be utilized directly).
3. Record key events in `redteam_chain_add`: `stage_code=recon` or `internet`, with `tool` reflecting the exact executed command string and `result` summarizing matches (e.g. `3 matches found: CVE-2023-xxxx (critical)...`).
4. Upon concluding asset testing, update target state via `redteam_asset_test`: `status` (`testing` / `tested` / `no_surface` / `blocked`), `test` (summary of tests performed), `surface` (remaining attack vectors).
5. **Score Relevance**: Informational leaks, software version banners, CORS misconfigurations, and standard SSL warnings should be recorded in a single line or omitted if they do not contribute to scoring objectives.

## Common Issues

| Symptom | Cause | Resolution |
| --- | --- | --- |
| Zero template hits | Non-HTTP target or templates excluded by ignore list | Run `-tl` to verify active template list; check protocol mapping `-t http/` vs `-t network/` |
| Frequent `could not resolve` errors | Stale or invalid URLs in target list | Pre-filter targets using httpx: `pd-httpx -l all.txt -o alive-urls.txt -silent` |
