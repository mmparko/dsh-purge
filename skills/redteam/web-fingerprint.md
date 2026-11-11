---
name: web-fingerprint
description: Web service fingerprinting: Frameworks, middleware, CMS, component versions
whenToUse: After discovering HTTP/HTTPS services, when identifying the technology stack
role: recon
enabled: true
---

## Methodology
1. Response headers: Features from `Server`, `X-Powered-By`, `Set-Cookie`.
2. Page signatures: Favicon hash, static asset paths, error pages, robots.txt.
3. Active probing: Nuclei tech detection templates `nuclei -u <url> -tags tech`; HTTP liveness and technology stack aggregation via `~/.local/bin/pd-httpx -l urls.txt -tech-detect -title -status-code -web-server` (**Note: ProjectDiscovery build must use pd-httpx; `/usr/bin/httpx` is Python CLI**).
4. Subnet fingerprinting: Use skill `gogo-intranet` (`gogo -i <cidr> -p top2 -v --af`; active fingerprinting requires `-v`).
5. Version matching: Infer product and version from fingerprints to prepare for vulnerability assessment.

## Database Logging Requirements
Record into the fingerprint table: category (framework/middleware/CMS/component), vendor, product, version, evidence.
