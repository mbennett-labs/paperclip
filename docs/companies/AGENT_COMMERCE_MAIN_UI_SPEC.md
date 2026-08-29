# Agent Commerce Main UI / Board Desk Specification

## Goal

Provide one explanatory human-facing surface in Paperclip that answers what is happening, why it matters, what requires human action, and where to go next without requiring the Board to manually reconcile Inbox, Issues, Subissues, Agents, Runs, and approvals.

Working name: **Board Desk**.

Board Desk does not replace Paperclip primitives. It composes and explains them.

## Primary Human Questions

The first screen must answer, in this order:

1. What is the company trying to accomplish right now?
2. What needs my attention?
3. What decisions are waiting on me?
4. What questions have agents asked me?
5. What is blocked?
6. What changed since I last reviewed the company?
7. What are the CEO and mission cells doing?
8. What evidence supports the current recommendation?
9. What money, permissions, or external actions are at risk?

## Page Structure

### 1. Board Brief

A plain-language CEO-generated but evidence-linked summary.

Required fields:
- Current Board directive.
- CEO interpretation.
- Current objective.
- Current phase.
- Recommended next Board action.
- Top risk/blocker.
- Last material change timestamp.

The summary must link to canonical issues and evidence; it is not itself the source of truth.

### 2. Needs You

A single queue of human-action items sourced from approvals, questions, exceptions, and review-ready work.

Each card must show:
- Type: Decision / Question / Exception / Review.
- Requester.
- Related mission/issue.
- One-sentence explanation.
- Recommended response, if any.
- Consequence of approval.
- Consequence of denial.
- Evidence link.

For decisions, expose explicit actions:
- Approve.
- Deny.
- Amend.
- Hold.
- Comment.

No implicit approval by navigation, silence, or generic comment.

### 3. Mission Map

Show:
- CEO at the top.
- Active mission cells underneath.
- Each cell's mission.
- Parent issue/project.
- Status.
- Authority/budget badge.
- Why the cell exists.
- Terminal condition.

A human should be able to distinguish permanent versus temporary cells immediately.

### 4. Active Missions

Show parent mission issues, not every implementation subissue.

Per mission:
- Objective.
- Owner.
- Progress/state.
- Current next action.
- Blocker.
- Last evidence-producing event.
- Number of hidden/rolled-up subissues.

Click-through opens the canonical issue tree.

### 5. Changes Since Last Review

Human-oriented delta feed, limited to material changes:
- New mission cell.
- Mission completed/retired.
- New Board decision request.
- Board decision recorded.
- New external action.
- Spend/budget change.
- Permission/credential change.
- Launch state change.
- Material experiment result.
- Governance hold/checkpoint change.

Avoid flooding this feed with heartbeat noise or routine subissue edits.

### 6. Risk / Spend / Authority

Compact control panel showing:
- Current approved budget envelope.
- Spend to date.
- Pending spend approvals.
- External write-capable integrations.
- Privileged credentials/scopes currently granted.
- Production-capable cells.
- Active governance holds.

### 7. Evidence & Results

Show the most decision-relevant evidence:
- Latest market evidence packet.
- Product evaluation.
- Transaction evidence.
- Reliability/cost results.
- Governance checkpoint.

Each item must carry provenance and fact/inference/unknown classification where appropriate.

## Relationship to Existing Paperclip Sections

### Inbox
Use as notification/urgency transport. Board Desk consumes and categorizes it.

### Issues
Remain canonical record for missions, work, discussions, evidence, and decisions.

### Subissues
Remain execution decomposition. Board Desk summarizes them upward.

### Agents
Remain detailed agent/cell configuration and status view. Board Desk shows only mission-relevant executive context.

### Runs / Heartbeats
Remain diagnostics and execution evidence. Do not expose routine run noise on the main Board surface.

### Approvals
Remain durable authorization records. Board Desk surfaces pending approvals and their context.

## Human Interaction Rules

- Every Board action must produce a durable event tied to an issue or approval record.
- Every agent question requiring a human answer must appear in Needs You.
- Every denied or held action remains visible until the requesting mission acknowledges the decision.
- Comments are context, not authority.
- Any action involving money, credentials, public launch, production write access, or irreversible external state must clearly show the requested authority before approval.
- The CEO should collapse low-level activity into parent mission state so humans do not need to chase subissues.

## CEO Main-UI Responsibilities

At every material state transition, CEO must update the Board-facing rollup with:
- What changed.
- Why it matters.
- What happens next.
- Whether human action is needed.
- Evidence references.

The CEO must never make the main summary look healthy by hiding blocked or failed subissues.

## Suggested Main Navigation

For this company, preferred ordering:

**Board Desk** | Inbox | Missions | Issues | Mission Cells | Approvals | Evidence | Runs | Settings

Board Desk should be the default landing page for a Board member.

## Minimal V0

Do not require a major frontend rewrite before company bootstrap. V0 can be implemented as an aggregate company dashboard backed by existing primitives.

Minimum V0 widgets:
- Board Brief.
- Needs You.
- Active Missions.
- Mission Cells.
- Material Changes.
- Risk/Spend/Authority.

The important requirement is explanatory aggregation and reliable deep links, not novel UI chrome.

## Acceptance Criteria

A Board member unfamiliar with the last 24 hours of activity should be able to open Board Desk and, without reading raw run logs or all subissues:

- Identify the current company objective.
- Identify every outstanding human decision/question.
- Understand what the CEO recommends and why.
- See which mission cells are active and what authority they hold.
- Find canonical evidence behind any material claim.
- Approve, deny, amend, hold, or comment from a clear context.
- Navigate to the exact issue/subissue/run only when deeper inspection is needed.