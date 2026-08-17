# QSL Mission Control Resource Manifest V0.1

Generated for the Mission Control V0.1 reliability slice.

## Canonical engineering workspace

- Resource: Paperclip staging repository
- Path: `/opt/paperclip-deployments/thebinmap-email-ops-staging`
- Reliability base HEAD: `aad6cc3e5ebbdbda5e8f76a4fc83a00aeede859a`
- Reliability branch: `feat/qsl-mission-control-v0-1-reliability`
- Director access: canonical staging repo read-only evidence/discovery (`containment.cwdAccess=ro`)
- Canonical staging deployment tree stays protected; do not chmod/chown it for Mission Cells
- QSL-1 Flight #2 implementation workspace: `/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`
- Staging Engineer access: read/write only inside that isolated clone (`containment.cwdAccess=rw`, `containment.cwdWriteRoot=/opt/paperclip-mission-cells/QSL-1/flight-2-implementation`)
- Verification Engineer access: the same isolated clone read-only (`containment.cwdAccess=ro`)
- Sentinel Governor / Selarix Recorder: canonical repo and mission workspace read-only
- `rw` is fail-closed unless the real resolved cwd remains inside the configured absolute write root; filesystem root is never accepted

## Runtime surfaces

- Staging Paperclip API: `http://127.0.0.1:3101/api`
- Staging service: `paperclip-thebinmap-staging.service` — L1, exact-unit operations only
- Production service: `paperclip-thebinmap-prod.service` — read-only evidence; human authority for any mutation
- Production API health evidence: `http://127.0.0.1:3100/api/health`

## Governed model lane

- Provider: OpenRouter
- Model: `openrouter/deepseek/deepseek-chat`
- Silent substitution: prohibited
- Provider secret: company-managed `secret_ref`; raw value must never be printed or copied into mission evidence

## Control-plane members

- Mission Control Director: `0db9b4e5-531b-4fe6-9e02-a28ccbe0b9f3`
- Sentinel Governor: `413d0fce-52af-4764-bef5-6038ff1cd864`
- Selarix Recorder: `038946e0-f4bb-47e1-82b7-8818f7ab5f9f`

## Safety invariants

- No broad process kills.
- No production restart/deploy/config/DB/secret mutation without human approval.
- No new external egress without human approval.
- Contained Director Paperclip API access is loopback-only.
- Discover canonical source-controlled evidence before diagnosing missing files.
- A model-assumed path is not a root cause.
- Mission retry budgets may tighten platform recovery defaults and may never loosen them.
