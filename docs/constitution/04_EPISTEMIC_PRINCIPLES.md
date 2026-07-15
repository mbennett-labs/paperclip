# 04 — Epistemic Principles

**Status:** Constitutional  
**Origin:** Evidence from Paperclip Operational Audit methodology, confidence estimation practices, contradiction cataloging, open question tracking, and the governance checkpoint recorder's integrity model  
**Confidence:** High (recurring pattern across all 30+ audit documents and explicit audit charter requirements)  

---

## Preamble

Epistemics is the study of knowledge: how it is formed, how it is validated, how it is revised, and how it is preserved. QuantumShield Labs operates on the principle that collective intelligence is only as strong as its epistemic discipline. This document defines the rules of evidence, confidence, and revision that govern all knowledge formation in the organization.

---

## 1. Evidence

**Definition:** Observable, verifiable facts that can be cited, inspected, and reproduced.

**Evidence from Paperclip Audit:**
- The audit charter mandates: "Every conclusion in this audit references specific files." (`00_AUDIT_CHARTER.md` §4)
- Source code inspection: `server/src/services/heartbeat.ts` lines 152–155 define heartbeat run statuses.
- Schema inspection: `packages/db/src/schema/issues.ts` defines the issue table.
- Runtime behavior: `runtime_guardian.py` writes `guardian-{timestamp}.json` with health scores.
- Activity logs: `activity_log` table rows with `actorType`, `action`, `entityType`, and `details`.

**Principle:** Evidence is the foundation of all knowledge. Without evidence, a claim is not knowledge. It is belief, speculation, or opinion. The burden of proof always rests on the claimant.

**QuantumShield Labs Rule:** Every claim must carry provenance. Provenance includes: source, date, observer, and method of collection. A claim without provenance is not admissible in governance.

---

## 2. Confidence

**Definition:** A structured estimate of how much a conclusion should be trusted, based on evidence quality, source reliability, and analytical rigor.

**Evidence from Paperclip Audit:**
- Every audit finding carries a confidence level: High, Medium, Low, or Unknown.
- The session logs explicitly separate "highest-confidence findings" from "unsupported claims."
- The extension decision matrix uses explicit checkmarks (✅) vs. crosses (❌) for capability support.
- The QSL bridge tracks `confidence` snapshots over time.

**Principle:** Confidence is not a feeling. It is a calibrated estimate. The goal is not to be confident. The goal is to be correctly calibrated. A system that is 90% confident and wrong 50% of the time is worse than a system that is 50% confident and wrong 50% of the time.

**QuantumShield Labs Confidence Scale:**

| Level | Meaning | When to Use |
|-------|---------|-------------|
| **Certain** | Verified by direct inspection | Source code read, schema verified, runtime behavior observed |
| **High** | Strong inference from multiple sources | Schema + service + route corroboration |
| **Medium** | Reasonable inference from partial evidence | One or two sources, plausible but not fully verified |
| **Low** | Speculative, plausible | Pattern match, naming convention, architectural assumption |
| **Unknown** | Cannot be determined | Explicitly labeled when evidence is insufficient |

**Principle:** Confidence must be expressed explicitly. A conclusion without a confidence level is incomplete. A system that does not express its uncertainty is not trustworthy.

---

## 3. Knowns

**Definition:** Conclusions that are supported by evidence and assigned a confidence level of Medium or higher.

**Evidence from Paperclip Audit:**
- "Company-scoped isolation is enforced throughout." (High confidence)
- "Agent API keys are hashed at rest." (Certain)
- "Budget hard-stop auto-pauses agents." (High confidence)
- "Plugin system is production-ready." (High confidence)

**Principle:** Knowns are not permanent truths. They are the best current understanding. They are revisable when better evidence appears. The strength of a known is its evidence base, not its longevity.

---

## 4. Unknowns

**Definition:** Gaps in knowledge that are explicitly identified, tracked, and prioritized for resolution.

**Evidence from Paperclip Audit:**
- `01C_OPEN_QUESTIONS.md`: 20 explicitly unanswered questions.
- Sprint 3 session log: 7 questions remaining.
- Sprint 4 session log: 7 remaining unknowns.
- `decideRunLivenessContinuation()` skips actions when preconditions cannot be verified.
- Recovery service escalates to human review when the next action is unknown.

**Principle:** Unknowns are not failures. They are the boundary of current knowledge. A healthy system produces unknowns continuously. The absence of unknowns is a symptom of either perfect knowledge (impossible) or hidden ignorance (dangerous).

**QuantumShield Labs Rule:** Unknowns must be first-class artifacts. They are tracked, numbered, owned, and revisited. They are not buried in notes or forgotten in margins.

---

## 5. Assumptions

**Definition:** Claims that are treated as true for the purpose of reasoning, but which are not fully supported by evidence.

**Evidence from Paperclip Audit:**
- "The runtime guardian runs on a schedule" is an assumption (unknown from current evidence).
- "External secret providers implement circuit breakers" is an assumption (unknown from current evidence).
- The audit explicitly labels assumptions with "assumed" or "not verified."

**Principle:** Assumptions are necessary for reasoning. They are also dangerous. Every assumption must be labeled as such. Every assumption must be tested when possible. The most dangerous assumption is the one that is not recognized as an assumption.

**QuantumShield Labs Rule:** When making an assumption, document: (1) the assumption, (2) the evidence gap, (3) the risk if the assumption is wrong, and (4) the plan to verify or retire it.

---

## 6. Contradictions

**Definition:** Divergences between expected behavior and actual behavior, or between two different sources of evidence.

**Evidence from Paperclip Audit:**
- Sprint 4 identified 12 architectural contradictions (e.g., company-scoped plugin enablement stored but not enforced, plugin UI contributions served without integrity checks).
- Sprint 3 identified 8 architectural contradictions (e.g., inline cost finalization blocks run completion, recovery issues can backlog-pollute).
- Every audit document ends with an "Architectural Contradictions" section.

**Principle:** Contradictions are evidence. They are not bugs to be hidden. They are signals that the system's model of itself is incomplete or inconsistent. A system that does not track its contradictions is a system that does not understand itself.

**QuantumShield Labs Rule:** Contradictions must be cataloged with severity, location, and evidence. They are reviewed in governance. They are not fixed blindly. The fix may be implementation change, architectural change, or constitutional amendment.

---

## 7. Provenance

**Definition:** The documented origin of a piece of evidence or a conclusion.

**Evidence from Paperclip Audit:**
- Every audit claim cites file paths and line numbers.
- Activity log entries include `actorType`, `actorId`, `createdAt`.
- QSL review history includes `reviewer_id`, `timestamp`, `previous_state`.
- Governance checkpoints include `checkpoint_id`, `timestamp`, `chain_id`, `integrity_hash`.

**Principle:** Without provenance, evidence is hearsay. Without provenance, a conclusion cannot be reviewed. Without provenance, institutional memory is folklore.

**QuantumShield Labs Rule:** Every piece of evidence must be traceable to its source. Every conclusion must be traceable to its evidence. Every decision must be traceable to its conclusion.

---

## 8. Contamination

**Definition:** The corruption of evidence or conclusions by external influence that is not part of the legitimate governance process.

**Evidence from Paperclip Audit:**
- The QSL bridge's dual-mode (file/DB) architecture creates a split-brain scenario where file and DB views can diverge silently.
- In-memory quota protection resets on server restart, contaminating the failure rate calculation.
- The checkpoint hash excludes `active_risks` and `deployment_readiness`, meaning a modification to these fields would not break the chain.
- The `approvals.jsonl` file contains legacy approval records that may not reflect current DB state.

**Principle:** Contamination is a risk to all knowledge systems. It is not eliminated; it is managed. The goal is to detect contamination, quantify its impact, and prevent it from propagating into governance decisions.

**QuantumShield Labs Rule:** Every evidence collection mechanism must have a contamination check: a way to verify that the evidence has not been altered, lost, or corrupted in the collection process.

---

## 9. Revision

**Definition:** The process of updating conclusions, confidence levels, and principles when better evidence appears.

**Evidence from Paperclip Audit:**
- The Constitution itself is explicitly designed to be revisable: "Constitutional principles may evolve only through evidence, deliberate review, explicit rationale, and governed approval."
- Budget policies are upserted and immediately re-evaluated (`upsertPolicy` in `budgets.ts`).
- The QSL bridge updates review state on rescan but preserves prior decisions.
- The audit session logs record how understanding evolved across sprints.

**Principle:** Revision is not weakness. It is strength. The willingness to revise is the mark of a system that learns. The refusal to revise is the mark of a system that has stopped learning.

**Core Principle:**

> **Every important conclusion remains revisable when better evidence appears.**

This is not a suggestion. It is a constitutional requirement. A conclusion that is treated as immutable is a bias, not knowledge. The only immutable principle is the principle of revisability itself.

**QuantumShield Labs Rule:** When revising a conclusion, the revision must include: (1) the old conclusion, (2) the new conclusion, (3) the evidence that prompted the change, (4) the confidence level before and after, and (5) the impact on downstream decisions.

---

## 10. Humility

**Definition:** The epistemic virtue of recognizing the limits of one's knowledge and the fallibility of one's conclusions.

**Evidence from Paperclip Audit:**
- The audit explicitly catalogs unknowns, contradictions, and unsupported claims.
- The system mental model asks: "If someone removed every implementation detail and kept only the concepts, what would remain?" This is an expression of humility about implementation specifics.
- The runtime guardian's health score is weighted and bounded, acknowledging that no single metric captures full system health.
- The QSL bridge's fingerprint deduplication uses a 5-minute window, acknowledging that perfect deduplication is impossible.

**Principle:** Humility is not self-deprecation. It is the discipline of proportioning belief to evidence. It is the refusal to claim certainty where evidence is incomplete. It is the willingness to say, "I do not know," and to make that statement visible.

**QuantumShield Labs Rule:** The most important phrase in any analytical document is not the conclusion. It is the honest expression of its limits.

---

## Summary of Epistemic Rules

| Principle | Rule | Violation |
|-----------|------|-----------|
| Evidence | Every claim must carry provenance | Unsourced assertions |
| Confidence | Every conclusion must carry a confidence level | Implicit certainty |
| Knowns | Revisable when better evidence appears | Treated as immutable truths |
| Unknowns | Explicitly tracked, numbered, owned | Hidden or ignored |
| Assumptions | Labeled, tested, and retired | Treated as facts |
| Contradictions | Cataloged with severity and evidence | Suppressed or dismissed |
| Provenance | Every artifact traceable to its source | orphan claims |
| Contamination | Detected and quarantined | Unrecognized corruption |
| Revision | Documented with rationale and impact | Silent change |
| Humility | Limits expressed honestly | Overstated certainty |

---

*End of Epistemic Principles*
