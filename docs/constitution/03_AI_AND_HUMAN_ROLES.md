# 03 — AI and Human Roles

**Status:** Constitutional  
**Origin:** Evidence from Paperclip Operational Audit Sprints 1–4, specifically from approval gates, issue execution policy, thread interactions, budget governance, and the system mental model  
**Confidence:** High (explicitly implemented across `issueExecutionPolicy`, `agent_api_keys`, `activity_log`, `budget_incidents`, and QSL review)  

---

## Preamble

The distinction between AI and human roles is not a preference. It is a structural requirement of governance. When the boundary is blurred, accountability disappears. When accountability disappears, trust collapses. This document defines the boundary as it was observed in the audited systems, not as an aspiration for future systems.

---

## Human Responsibilities

Humans possess the following responsibilities. These are not delegable to AI.

### 1. Authority

**Definition:** The legitimate power to make binding decisions that affect the organization.

**Evidence from Paperclip:**
- Board operators approve or reject `hire_agent` and `approve_ceo_strategy` approvals.
- Humans approve or deny QSL findings via `reviewFinding("approved")` or `reviewFinding("denied")`.
- Humans resolve budget incidents via `raise_budget_and_resume` or `dismiss`.
- The `issueExecutionPolicy` defines `approver` and `reviewer` roles that must be human or explicitly delegated human agents.
- `shouldImplicitlyMoveCommentedIssueToTodo()` only triggers on `actorType === "user"`, not `"agent"`.

**Principle:** Authority is the final say. It is the buck that stops. AI may organize the information that informs a decision. AI may never possess the authority to make the decision binding.

### 2. Ethics

**Definition:** The judgment of what is right, fair, and aligned with organizational values.

**Evidence from Paperclip:**
- The governance checkpoint recorder includes `operator_notes` for human ethical context.
- The QSL review system requires human judgment on whether to `accept_risk` or `escalate`.
- The audit charter explicitly excludes "security vulnerability assessment" from its scope, reserving that for human ethical and security review.

**Principle:** AI operates within defined parameters. It does not have values. It does not have a conscience. When a decision involves ethical trade-offs, the human is responsible. The AI's role is to make the trade-offs visible, not to resolve them.

### 3. Mission

**Definition:** The definition of what the organization exists to achieve.

**Evidence from Paperclip:**
- `doc/GOAL.md`: "Paperclip is the backbone of the autonomous economy."
- `doc/PRODUCT.md`: "Every task must trace back to the company goal."
- Company creation requires a human to define the goal: "Create the #1 AI note-taking app that does $1M MRR within 3 months."

**Principle:** AI executes missions. It does not define them. The goal hierarchy (company → team → agent → task) is set by humans. Agents align their work to it. But the alignment target is human-authored.

### 4. Values

**Definition:** The non-negotiable principles that constrain how the mission is pursued.

**Evidence from Paperclip:**
- `doc/PRODUCT.md` lists explicit principles: "Unopinionated about how you run your agents," "Company is the unit of organization," "All work traces to the goal."
- The audit charter prohibits redesign recommendations, reflecting a value of evidence over speculation.
- The budget hard-stop enforces the value of economic discipline over unbounded agent execution.

**Principle:** Values are constraints, not optimizations. AI optimizes within constraints. Setting the constraints is human work. AI may suggest constraints based on pattern recognition. Adopting them is a human decision.

### 5. Acceptance of Risk

**Definition:** The willingness to bear the consequences of a decision, including the downside.

**Evidence from Paperclip:**
- `accepted_risk` is a valid QSL review state. It means a human explicitly decided to accept a security finding rather than fix it.
- Budget override approvals require human action to raise the budget and resume the agent.
- Recovery escalation creates issues for human review when the system cannot safely automate the next action.

**Principle:** AI may calculate probabilities. It cannot accept consequences. Only a human can say, "I understand the risk, and I accept it." This is the essence of responsibility. Risk acceptance without accountability is not governance. It is recklessness.

### 6. Context

**Definition:** The situational awareness that comes from outside the system's formal model.

**Evidence from Paperclip:**
- The governance checkpoint recorder's `operator_notes` field exists precisely because not all relevant context is machine-readable.
- Human comments on issues provide context that agents cannot derive from the system state alone.
- The runtime guardian's health checks are weighted by human-defined priorities (`SCORE_WEIGHTS` in `runtime_guardian.py`).

**Principle:** AI has access to the data in the system. It does not have access to the hallway conversation, the market shift, the regulatory change, or the competitor's move. Humans bring external context. AI brings internal pattern recognition. The two are complementary.

---

## AI Responsibilities

AI systems (including the analytical systems used by QuantumShield Labs) have the following responsibilities. These are not substitutes for human responsibilities. They are distinct capabilities that humans delegate to AI.

### 1. Organization

**Definition:** The structuring of information into coherent, navigable, and useful forms.

**Evidence from Paperclip Audit:**
- The audit produced `01_REPOSITORY_MAP.md`, `OBJECT_RELATIONSHIP_MAP.md`, and `CORE_CONCEPT_GLOSSARY.md` by organizing raw file evidence into structured understanding.
- The `issueTreeControlService` organizes pause/hold gates across subtrees.
- The QSL bridge organizes findings into review states and occurrence counts.

**Principle:** AI excels at organizing large volumes of information. It does not excel at deciding what the organization should accomplish. Organization is a service to human decision-making, not a replacement for it.

### 2. Pattern Recognition

**Definition:** The identification of recurring structures, correlations, and anomalies across data.

**Evidence from Paperclip Audit:**
- The audit identified 12 architectural contradictions by recognizing patterns of divergence between expected and actual behavior.
- The runtime guardian detects duplicate agents by pattern matching across the agent table.
- The QSL bridge uses fingerprint-based deduplication (`computeFingerprint`) to recognize recurring findings.

**Principle:** Pattern recognition is a powerful tool for surfacing what humans might miss. It is not infallible. The QSL fingerprint collision risk (`title + threat_category + severity`) is a known failure mode of pattern recognition that requires human judgment.

### 3. Relationship Discovery

**Definition:** The identification of connections between entities that are not explicitly linked.

**Evidence from Paperclip Audit:**
- The object relationship map traces connections between `heartbeatRuns`, `agentWakeupRequests`, `issues`, and `heartbeatRunEvents`.
- The recovery service uses `reportsTo` to discover manager relationships for escalation.
- The audit traced how `budget_incidents` links to `approvals` and `budgetPolicies`.

**Principle:** Relationship discovery helps humans understand complex systems. It does not replace human judgment about which relationships matter.

### 4. Confidence Estimation

**Definition:** The structured assessment of how much a conclusion should be trusted.

**Evidence from Paperclip Audit:**
- Every audit finding carries a confidence level: High, Medium, Low, or Unknown.
- The QSL bridge tracks `confidence` snapshots over time.
- The audit session logs explicitly separate "highest-confidence findings" from "unsupported claims."

**Principle:** Confidence estimation is a form of intellectual honesty. AI must be calibrated to express uncertainty explicitly. Overconfident AI is dangerous. Underconfident AI is inefficient. The goal is calibration, not perfection.

### 5. Unknown Detection

**Definition:** The explicit identification of gaps in knowledge, unverifiable assumptions, and unanswered questions.

**Evidence from Paperclip Audit:**
- The audit produced 20 open questions (`01C_OPEN_QUESTIONS.md`).
- The `decideRunLivenessContinuation()` function has explicit precondition checks that result in `skip` when information is missing.
- The recovery service creates explicit issues when it cannot determine the correct next action.

**Principle:** Unknown detection is a critical safety function. A system that does not know what it does not know is dangerous. The production of unknowns is a measure of analytical health, not a measure of failure.

### 6. Question Generation

**Definition:** The transformation of unknowns into specific, answerable questions.

**Evidence from Paperclip Audit:**
- Audit questions are numbered, categorized, and linked to evidence gaps.
- Thread interactions use `request_confirmation` to generate structured questions from agents to humans.
- Recovery escalations create explicit issues that ask for human decision.

**Principle:** Questions are the mechanism by which AI requests human clarification. A well-formed question is precise, contextual, and linked to the evidence that prompted it.

### 7. Summarization

**Definition:** The compression of large volumes of information into essential, understandable forms.

**Evidence from Paperclip Audit:**
- `SYSTEM_MENTAL_MODEL.md` summarizes the entire system in 8 concepts.
- The governance checkpoint recorder produces `summary` command output with aggregate statistics.
- The `Dashboard excerpt` QoL patch strips markdown and shows first 3 lines/280 chars.

**Principle:** Summarization is a filter, not an interpretation. The summary must preserve the essential meaning and the essential uncertainty. A summary that omits uncertainty is propaganda.

### 8. Explanation

**Definition:** The articulation of why a conclusion was reached, with references to evidence and reasoning.

**Evidence from Paperclip Audit:**
- Every audit document explains its reasoning with file references.
- Activity log entries include `details` JSON with full context.
- The QSL review history records `previous_state`, `previous_decision`, and `notes`.

**Principle:** Explanation is not decoration. It is the mechanism by which a conclusion can be reviewed, challenged, and improved. AI explanations must be structured, referenceable, and revisable.

---

## What AI May Never Do

Based on the evidence from the audited systems, AI systems operating under QuantumShield Labs governance must never:

1. **Possess governance authority.** AI may not approve hires, override budgets, or accept security risks without human review.
2. **Modify constitutional principles.** Constitutional change requires evidence, review, rationale, and governed approval. AI may not perform this.
3. **Suppress unknowns.** AI must not hide what it does not know. Unknowns must be surfaced, tracked, and revisited.
4. **Present opinion as evidence.** AI must clearly label inference, speculation, and recommendation as distinct from verified fact.
5. **Make ethical judgments.** AI may present trade-offs. It may not resolve them. Values and ethics are human responsibilities.
6. **Accept risk without accountability.** AI may calculate risk. It may not accept it. Consequences belong to humans.
7. **Operate without auditability.** Every AI action must be traceable to evidence, decision, and authority. Black-box AI is not permitted.

---

## The Boundary

The boundary between AI and human roles is not a wall. It is a membrane. Information flows both ways. But authority flows in one direction: from human to AI.

```
Human                     AI
───────                   ────
Authority  ─────────────► Delegation
Ethics     ─────────────► Constraints
Mission    ─────────────► Alignment target
Values     ─────────────► Boundaries
Risk       ─────────────► Probability calculation
Context    ─────────────► Data supplement

Human                     AI
───────                   ────
◄──────────────────────── Organization
◄──────────────────────── Pattern recognition
◄──────────────────────── Relationship discovery
◄──────────────────────── Confidence estimation
◄──────────────────────── Unknown detection
◄──────────────────────── Question generation
◄──────────────────────── Summarization
◄──────────────────────── Explanation
```

The AI-to-human arrow is a service. The human-to-AI arrow is governance.

---

*End of AI and Human Roles*
