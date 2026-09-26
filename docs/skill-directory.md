# Read-only Skill directory

The retained **Skills 能力** directory component and `GET /api/v1/skills` share a build-time source
snapshot. The standalone Koubo editor no longer exposes a directory button or mounts this dialog.
This is not the user's installed Plugin inventory, a Marketplace
client, an installer, or proof that a Skill is loaded or compatible.

## Source and maintenance

`packages/contracts/src/skill-directory.generated.ts` is generated from an
explicit `skills.local-candidate.json`, the same default selection used by the
local suite installer. The package builder also regenerates this snapshot.
No source repository is imported at runtime. Regenerate and check using:

```sh
bun run skills:directory:export skills.local-candidate.json
bun run skills:directory:export skills.local-candidate.json --check
```

Schema 2 identifies independent local candidates, their versions, content hashes,
minimum Runtime versions and the exact catalog hash. Only default entries appear:
install, cut, subtitle, export, maintain, shot-design and xiaohei. Legacy aliases and
private bird do not. There is no invented public commit or release-ready claim.
The exporter rejects malformed metadata and never runs package code or downloads.
An old schema 1 consumer must be updated explicitly; it cannot treat this as the
old bundled Plugin snapshot.

## Ownership

- Studio may search metadata and compose a user-visible request for the Agent.
- The Agent checks its actual loaded Skills and official Plugin state; installation
  requires the user's explicit confirmation and the official host mechanism.
- Runtime does not inspect or write host configuration or run installation code.
- All installed/enabled/loaded/compatible states in the snapshot remain `unknown`.
- POST/PUT/PATCH/DELETE and path/query injection are rejected by the endpoint.

Remote Marketplace adapters, host inventory and external-tool conversion remain
outside this directory. Independent packaging and local receipts are handled by
the separate installer, not this API. Test the directory API,
Studio loading/failure cases and the exporter drift check before updating it.
