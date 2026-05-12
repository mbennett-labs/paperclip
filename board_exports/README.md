# Board Intelligence Export

Structured exports of Paperclip operational state for cross-tool reasoning by ChatGPT, Claude Code, and the Paperclip board.

## Generated Files

| File | Format | Contents |
|------|--------|----------|
| `company_map.json` | JSON | Companies with projects, routines, budgets |
| `company_map.md` | Markdown | Human-readable company overview |
| `agents.json` | JSON | All agents with configs, permissions, heartbeat |
| `agents.md` | Markdown | Agent roster grouped by company |
| `issues.json` | JSON | Open/recent issues with latest activity |
| `issues.md` | Markdown | Issue triage view with urgent/blocked sections |
| `governance.md` | Markdown | Approval rules, pending approvals, permission grants, authority tiers |
| `crawdaddy_transaction_integrity.md` | Markdown | Payment/scan/fulfillment issues, budget incidents, cost events |
| `board_review_packet.md` | Markdown | Executive summary combining all domains |
| `board_export_bundle.json` | JSON | Complete bundle of all export data |

## How to Generate

### CLI Script

```bash
# Set DATABASE_URL or have the embedded Postgres running
DATABASE_URL=postgres://... npx tsx server/scripts/generate-board-export.ts

# Custom output directory
DATABASE_URL=postgres://... npx tsx server/scripts/generate-board-export.ts --output ./my-exports
```

### API Endpoint

When the Paperclip server is running:

```
GET /api/board-export          → full bundle (JSON)
GET /api/board-export/companies → companies only
GET /api/board-export/agents    → agents only
GET /api/board-export/issues    → issues only
GET /api/board-export/governance → governance only
GET /api/board-export/crawdaddy  → CrawDaddy transaction integrity
```

## Data Sources

All data is queried live from the Paperclip database:

- **Companies** — `companies`, `projects`, `routines`, `budget_policies` tables
- **Agents** — `agents`, `company_skills` tables + adapter/runtime config parsing
- **Issues** — `issues`, `issue_comments` tables (open + last 7 days completed)
- **Governance** — `approvals`, `principal_permission_grants`, `company_memberships` tables
- **CrawDaddy** — keyword-filtered issues + `budget_incidents`, `cost_events` tables

## Usage with AI Tools

Feed any `.md` or `.json` file to ChatGPT, Claude Code, or other AI tools:

```bash
# Claude Code — reference directly
cat board_exports/board_review_packet.md

# ChatGPT — paste or upload
# Copy board_exports/board_review_packet.md into the conversation

# Programmatic — use the API endpoint
curl http://localhost:3001/api/board-export | jq .
```
