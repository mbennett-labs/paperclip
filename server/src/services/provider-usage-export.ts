/**
 * Provider Usage Export
 *
 * Generates provider_usage.md for board exports with full provider
 * observability: costs, token usage, fallback runs, rate-limit incidents,
 * and top-consuming agents.
 *
 * Co-Authored-By: Paperclip <noreply@paperclip.ing>
 */
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { providerRoutingService } from "./provider-routing.js";

export async function generateProviderUsageExport(db: Db): Promise<string> {
  const allCompanies = await db.select().from(companies);
  const allAgents = await db.select().from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a.name]));
  const routingService = providerRoutingService(db);

  const lines: string[] = [
    "# Provider Usage Report",
    "",
    `> Generated ${new Date().toISOString()}`,
    "",
  ];

  for (const co of allCompanies) {
    const analytics = await routingService.getProviderAnalytics(co.id, 30);
    const quota = await routingService.getQuotaStatus(co.id);

    lines.push(`## ${co.name}`);
    lines.push("");

    // Quota status
    lines.push("### Quota Status");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Monthly usage | $${(quota.totalCostCents / 100).toFixed(2)} |`);
    lines.push(`| Usage level | ${quota.usagePercent.toFixed(1)}% |`);
    lines.push(`| Status | ${quota.isExhausted ? "**EXHAUSTED**" : quota.isCritical ? "**CRITICAL**" : "OK"} |`);
    lines.push(`| Rate-limit incidents (1h) | ${quota.rateLimitIncidents} |`);
    lines.push("");

    // Provider breakdown
    if (analytics.providerBreakdown.length > 0) {
      lines.push("### Provider Breakdown (30 days)");
      lines.push("");
      lines.push("| Provider | Model | Cost | Tokens | Runs |");
      lines.push("|----------|-------|------|--------|------|");
      for (const row of analytics.providerBreakdown) {
        lines.push(
          `| ${row.provider} | ${row.model} | $${(row.totalCents / 100).toFixed(2)} | ${row.totalTokens.toLocaleString()} | ${row.runCount} |`,
        );
      }
      lines.push("");
    }

    // Fallback & incidents
    lines.push("### Routing Health");
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Fallback runs (30 days) | ${analytics.fallbackRuns} |`);
    lines.push(`| Rate-limit incidents (30 days) | ${analytics.rateLimitIncidents} |`);
    lines.push("");

    // Top consuming agents
    if (analytics.topAgents.length > 0) {
      lines.push("### Top Token-Consuming Agents");
      lines.push("");
      lines.push("| Agent | Cost (30d) |");
      lines.push("|-------|-----------|");
      for (const agent of analytics.topAgents) {
        const name = agentMap.get(agent.agentId) ?? agent.agentId.slice(0, 8);
        lines.push(`| ${name} | $${(agent.totalCents / 100).toFixed(2)} |`);
      }
      lines.push("");
    }
  }

  // Routing policy summary
  lines.push("## Routing Policy");
  lines.push("");
  lines.push("### Fallback DENIED (always Claude)");
  lines.push("- CEO, GateKeeper, Security Engineer, QA Engineer");
  lines.push("");
  lines.push("### Fallback ENABLED (OpenRouter/DeepSeek when needed)");
  lines.push("- WatchDog, TrustScore, Content Strategist, General agents");
  lines.push("");
  lines.push("### Actions NEVER routed to fallback");
  lines.push("- Wallet changes, production deployments, credential rotation");
  lines.push("- Board approvals, payment execution, infrastructure mutation");
  lines.push("");
  lines.push("### Default fallback");
  lines.push("- Provider: OpenRouter");
  lines.push("- Model: deepseek/deepseek-chat");
  lines.push("");

  return lines.join("\n");
}
