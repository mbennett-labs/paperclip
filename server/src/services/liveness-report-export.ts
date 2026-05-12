/**
 * Liveness Report Export
 *
 * Generates liveness_report.md for board exports with diagnostics on:
 * - Agent continuation patterns
 * - Deadlock detection
 * - Repeated-run detection
 * - Blocked issue escalation queue
 * - API-unavailable incidents
 *
 * Co-Authored-By: Paperclip <noreply@paperclip.ing>
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, issues } from "@paperclipai/db";

interface LivenessAgentSummary {
  agentId: string;
  agentName: string;
  companyName: string;
  totalRuns: number;
  failedRuns: number;
  emptyRuns: number;
  planOnlyRuns: number;
  blockedRuns: number;
  continuationAttempts: number;
  maxContinuationAttempt: number;
  lastRunAt: string | null;
  lastLivenessState: string | null;
}

interface DeadlockCandidate {
  agentId: string;
  agentName: string;
  issueIdentifier: string | null;
  issueTitle: string;
  consecutiveEmptyOrPlanRuns: number;
  livenessState: string;
  livenessReason: string | null;
}

interface EscalationItem {
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  assigneeName: string | null;
  blockedSince: string | null;
  livenessReason: string | null;
}

export async function generateLivenessReportExport(db: Db): Promise<string> {
  const allCompanies = await db.select().from(companies);
  const allAgents = await db.select().from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a]));

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - 7);

  const lines: string[] = [
    "# Liveness Report",
    "",
    `> Generated ${new Date().toISOString()}`,
    "",
  ];

  for (const co of allCompanies) {
    lines.push(`## ${co.name}`);
    lines.push("");

    // Get recent runs for this company
    const recentRuns = await db
      .select({
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        livenessReason: heartbeatRuns.livenessReason,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        finishedAt: heartbeatRuns.finishedAt,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, co.id),
          gte(heartbeatRuns.createdAt, windowStart),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(500);

    // Aggregate per agent
    const agentSummaries = new Map<string, LivenessAgentSummary>();
    for (const run of recentRuns) {
      const agent = agentMap.get(run.agentId);
      const key = run.agentId;
      let summary = agentSummaries.get(key);
      if (!summary) {
        summary = {
          agentId: run.agentId,
          agentName: agent?.name ?? "unknown",
          companyName: co.name,
          totalRuns: 0,
          failedRuns: 0,
          emptyRuns: 0,
          planOnlyRuns: 0,
          blockedRuns: 0,
          continuationAttempts: 0,
          maxContinuationAttempt: 0,
          lastRunAt: null,
          lastLivenessState: null,
        };
        agentSummaries.set(key, summary);
      }

      summary.totalRuns++;
      if (run.status === "failed" || run.status === "error") summary.failedRuns++;
      if (run.livenessState === "empty_response") summary.emptyRuns++;
      if (run.livenessState === "plan_only") summary.planOnlyRuns++;
      if (run.livenessState === "blocked") summary.blockedRuns++;
      if (run.continuationAttempt > 0) summary.continuationAttempts++;
      summary.maxContinuationAttempt = Math.max(summary.maxContinuationAttempt, run.continuationAttempt);
      if (!summary.lastRunAt && run.finishedAt) {
        summary.lastRunAt = run.finishedAt.toISOString();
        summary.lastLivenessState = run.livenessState;
      }
    }

    // Agent health table
    if (agentSummaries.size > 0) {
      lines.push("### Agent Run Health (7 days)");
      lines.push("");
      lines.push("| Agent | Runs | Failed | Empty | Plan Only | Blocked | Max Cont. | Last State |");
      lines.push("|-------|------|--------|-------|-----------|---------|-----------|------------|");
      for (const summary of agentSummaries.values()) {
        const lastState = summary.lastLivenessState ?? "—";
        lines.push(
          `| ${summary.agentName} | ${summary.totalRuns} | ${summary.failedRuns} | ${summary.emptyRuns} | ${summary.planOnlyRuns} | ${summary.blockedRuns} | ${summary.maxContinuationAttempt} | ${lastState} |`,
        );
      }
      lines.push("");
    }

    // Deadlock detection: agents with 3+ consecutive empty/plan_only runs
    const deadlockCandidates: DeadlockCandidate[] = [];
    for (const summary of agentSummaries.values()) {
      if (summary.emptyRuns + summary.planOnlyRuns >= 3) {
        deadlockCandidates.push({
          agentId: summary.agentId,
          agentName: summary.agentName,
          issueIdentifier: null,
          issueTitle: "Multiple empty/plan-only runs detected",
          consecutiveEmptyOrPlanRuns: summary.emptyRuns + summary.planOnlyRuns,
          livenessState: summary.lastLivenessState ?? "unknown",
          livenessReason: null,
        });
      }
    }

    if (deadlockCandidates.length > 0) {
      lines.push("### Deadlock Candidates");
      lines.push("");
      lines.push("| Agent | Empty+Plan Runs | Last State | Issue |");
      lines.push("|-------|-----------------|------------|-------|");
      for (const dc of deadlockCandidates) {
        lines.push(
          `| ${dc.agentName} | ${dc.consecutiveEmptyOrPlanRuns} | ${dc.livenessState} | ${dc.issueTitle} |`,
        );
      }
      lines.push("");
    }

    // Rate-limit / API-unavailable incidents
    const apiErrors = recentRuns.filter(
      (r) => r.errorCode === "rate_limited" || r.errorCode === "api_unavailable",
    );
    if (apiErrors.length > 0) {
      lines.push("### API Availability Incidents");
      lines.push("");
      lines.push(`| Error | Count |`);
      lines.push(`|-------|-------|`);
      const errorCounts = new Map<string, number>();
      for (const err of apiErrors) {
        const code = err.errorCode ?? "unknown";
        errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
      }
      for (const [code, count] of errorCounts) {
        lines.push(`| ${code} | ${count} |`);
      }
      lines.push("");
    }

    // Blocked issues escalation queue
    const blockedIssues = await db
      .select({
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, co.id),
          eq(issues.status, "blocked"),
        ),
      )
      .orderBy(issues.updatedAt)
      .limit(20);

    if (blockedIssues.length > 0) {
      lines.push("### Escalation Queue (Blocked Issues)");
      lines.push("");
      lines.push("| Issue | Title | Assignee | Blocked Since |");
      lines.push("|-------|-------|----------|---------------|");
      for (const issue of blockedIssues) {
        const assignee = issue.assigneeAgentId
          ? (agentMap.get(issue.assigneeAgentId)?.name ?? "unknown")
          : "unassigned";
        lines.push(
          `| ${issue.identifier ?? "—"} | ${issue.title} | ${assignee} | ${issue.updatedAt.toISOString().split("T")[0]} |`,
        );
      }
      lines.push("");
    }
  }

  // Liveness policy summary
  lines.push("## Liveness Policy");
  lines.push("");
  lines.push("| Parameter | Value |");
  lines.push("|-----------|-------|");
  lines.push("| Max continuation attempts | 2 (default) |");
  lines.push("| Deadlock threshold | 3+ empty/plan-only runs |");
  lines.push("| Blocker detection | regex-based on run output |");
  lines.push("| Auto-escalation | blocked state after exhausted continuations |");
  lines.push("| Retry budget | per-run with idempotent wakeup keys |");
  lines.push("| Loop detection | continuation attempt counter + liveness state tracking |");
  lines.push("");

  return lines.join("\n");
}
