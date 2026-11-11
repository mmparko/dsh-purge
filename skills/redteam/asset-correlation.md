---
name: asset-correlation
description: Asset correlation: Graphing Domain <-> IP <-> CIDR <-> Certificate <-> Service relationships
whenToUse: At the conclusion of reconnaissance phases when forming an asset relationship map
role: recon
enabled: true
---

## Correlation Rules
- Domain resolution -> `resolves` edge (domain -> asset)
- CIDR membership -> `contains` edge (segment -> asset)
- Open port -> `exposes` edge (asset -> port)
- Shared Certificate SAN -> `shares_cert` edge

## Database Logging Requirements
Write to the edge table via `redteam_asset_link`; duplicate relationships are idempotent.
