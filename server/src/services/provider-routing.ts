/**
 * Provider-Aware Routing + Fallback Orchestration
 *
 * Implements intelligent provider routing with OpenRouter/DeepSeek fallback
 * when Claude quota or rate limits are hit. Respects governance rules:
 * high-risk agents never fallback to cheaper providers.
 *
 * Co-Authored-By: Paperclip <noreply@paperclip.ing>
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ProviderRoutingConfig {
  /** Primary provider (e.g. "anthropic", "openrouter") */
  primaryProvider: string;
  /** Primary model identifier */
  primaryModel: string;
  /** Fallback provider when primary is unavailable */
  fallbackProvider: string | null;
  /** Fallback model */
  fallbackModel: string | null;
  /** Allow fallback on rate-limit errors */
  allowFallbackOnRateLimit: boolean;
  /** Allow fallback on quota exhaustion */
  allowFallbackOnQuotaExhaust: boolean;
}

export interface ProviderRoutingDecision {
  /** Which provider to use */
  provider: string;
  /** Which model to use */
  model: string;
  /** Whether this is a fallback route */
  isFallback: boolean;
  /** Reason for the routing decision */
  reason: string;
}

export interface QuotaStatus {
  /** Current usage percentage (0-100) */
  usagePercent: number;
  /** Whether quota is exhausted (>= 100%) */
  isExhausted: boolean;
  /** Whether in critical zone (>= 90%) */
  isCritical: boolean;
  /** Total cost cents in current window */
  totalCostCents: number;
  /** Rate-limit incidents in last hour */
  rateLimitIncidents: number;
}

export interface ProviderEvent {
  id: string;
  provider: string;
  eventType: "rate_limit" | "quota_exhausted" | "api_error" | "fallback_triggered" | "recovered";
  agentId: string | null;
  companyId: string;
  detail: string | null;
  occurredAt: Date;
}

// ── Agent role classification ─────────────────────────────────────────

/**
 * Agents that must NEVER use fallback providers.
 * These handle security-sensitive, financial, or governance-critical tasks.
 */
const FALLBACK_DENIED_ROLES = new Set([
  "ceo",
  "gatekeeper",
  "security_engineer",
  "qa_engineer",
]);

/**
 * Action types that must NEVER be routed to fallback providers,
 * regardless of agent role.
 */
const FALLBACK_DENIED_ACTIONS = new Set([
  "wallet_change",
  "production_deployment",
  "destructive_shell",
  "credential_rotation",
  "board_approval",
  "payment_execution",
  "infrastructure_mutation",
]);

/**
 * Agents that CAN use fallback providers for non-critical work.
 */
const FALLBACK_ALLOWED_ROLES = new Set([
  "watchdog",
  "trust_score",
  "content_strategist",
  "general",
]);

// ── Default configuration ─────────────────────────────────────────────

const DEFAULT_FALLBACK_PROVIDER = "openrouter";
const DEFAULT_FALLBACK_MODEL = "deepseek/deepseek-chat";

/** Monthly quota budget (cents) — used for percentage calculations */
const DEFAULT_MONTHLY_QUOTA_CENTS = 50_00; // $50 default

/** Rate-limit incident threshold before triggering fallback */
const RATE_LIMIT_THRESHOLD = 3;

/** Window for rate-limit incident counting (ms) */
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ── Service ───────────────────────────────────────────────────────────

/** In-memory cache of recent rate-limit events for fast routing decisions */
const rateLimitCache = new Map<string, { count: number; lastSeen: Date }>();

export function providerRoutingService(db: Db) {
  return {
    /**
     * Get the provider routing configuration for an agent.
     * Reads from agent runtimeConfig, falling back to system defaults.
     */
    getRoutingConfig(
      agentRole: string,
      runtimeConfig: Record<string, unknown>,
      adapterConfig: Record<string, unknown>,
    ): ProviderRoutingConfig {
      const routing = (runtimeConfig.providerRouting ?? {}) as Record<string, unknown>;

      const primaryProvider = typeof routing.primaryProvider === "string"
        ? routing.primaryProvider
        : "anthropic";

      const primaryModel = typeof adapterConfig.model === "string"
        ? adapterConfig.model
        : typeof routing.primaryModel === "string"
          ? routing.primaryModel
          : "claude-sonnet-4-6";

      const canFallback = !FALLBACK_DENIED_ROLES.has(agentRole.toLowerCase().replace(/\s+/g, "_"));

      const fallbackProvider = canFallback
        ? (typeof routing.fallbackProvider === "string"
          ? routing.fallbackProvider
          : DEFAULT_FALLBACK_PROVIDER)
        : null;

      const fallbackModel = canFallback
        ? (typeof routing.fallbackModel === "string"
          ? routing.fallbackModel
          : DEFAULT_FALLBACK_MODEL)
        : null;

      return {
        primaryProvider,
        primaryModel,
        fallbackProvider,
        fallbackModel,
        allowFallbackOnRateLimit: canFallback && (routing.allowFallbackOnRateLimit !== false),
        allowFallbackOnQuotaExhaust: canFallback && (routing.allowFallbackOnQuotaExhaust !== false),
      };
    },

    /**
     * Get current quota status for a company.
     */
    async getQuotaStatus(companyId: string): Promise<QuotaStatus> {
      const now = new Date();
      const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);

      // Get total costs this month
      const [costResult] = await db
        .select({ total: sql<number>`COALESCE(SUM(${costEvents.costCents}), 0)` })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, windowStart),
          ),
        );

      const totalCostCents = costResult?.total ?? 0;

      // Count rate-limit incidents in the last hour
      const rateLimitCutoff = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
      const [rateLimitResult] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.errorCode, "rate_limited"),
            gte(heartbeatRuns.finishedAt, rateLimitCutoff),
          ),
        );

      const rateLimitIncidents = rateLimitResult?.count ?? 0;
      const usagePercent = Math.min(100, (totalCostCents / DEFAULT_MONTHLY_QUOTA_CENTS) * 100);

      return {
        usagePercent,
        isExhausted: usagePercent >= 100,
        isCritical: usagePercent >= 90,
        totalCostCents,
        rateLimitIncidents,
      };
    },

    /**
     * Make a provider routing decision for an agent run.
     */
    async route(
      companyId: string,
      agentId: string,
      agentRole: string,
      agentName: string,
      runtimeConfig: Record<string, unknown>,
      adapterConfig: Record<string, unknown>,
    ): Promise<ProviderRoutingDecision> {
      const config = this.getRoutingConfig(agentRole, runtimeConfig, adapterConfig);

      // If no fallback configured, always use primary
      if (!config.fallbackProvider || !config.fallbackModel) {
        return {
          provider: config.primaryProvider,
          model: config.primaryModel,
          isFallback: false,
          reason: "no_fallback_configured",
        };
      }

      // Check rate-limit cache first (fast path)
      const cacheKey = `${companyId}:${config.primaryProvider}`;
      const cached = rateLimitCache.get(cacheKey);
      const now = new Date();

      if (cached && cached.count >= RATE_LIMIT_THRESHOLD) {
        const age = now.getTime() - cached.lastSeen.getTime();
        if (age < RATE_LIMIT_WINDOW_MS && config.allowFallbackOnRateLimit) {
          logger.info(
            { agentId, agentName, provider: config.fallbackProvider, model: config.fallbackModel },
            "routing to fallback: rate-limit threshold exceeded",
          );
          return {
            provider: config.fallbackProvider,
            model: config.fallbackModel,
            isFallback: true,
            reason: "rate_limit_threshold",
          };
        }
        // Cache expired, clear it
        if (age >= RATE_LIMIT_WINDOW_MS) {
          rateLimitCache.delete(cacheKey);
        }
      }

      // Check quota status (slower path, hit DB)
      const quota = await this.getQuotaStatus(companyId);

      if (quota.isExhausted && config.allowFallbackOnQuotaExhaust) {
        logger.info(
          { agentId, agentName, usagePercent: quota.usagePercent },
          "routing to fallback: quota exhausted",
        );
        return {
          provider: config.fallbackProvider,
          model: config.fallbackModel,
          isFallback: true,
          reason: "quota_exhausted",
        };
      }

      if (quota.isCritical) {
        // In critical zone, only allow critical agents to use primary
        const isCriticalAgent = FALLBACK_DENIED_ROLES.has(
          agentRole.toLowerCase().replace(/\s+/g, "_"),
        );
        if (!isCriticalAgent && config.allowFallbackOnQuotaExhaust) {
          logger.info(
            { agentId, agentName, usagePercent: quota.usagePercent },
            "routing to fallback: critical quota zone, non-critical agent",
          );
          return {
            provider: config.fallbackProvider,
            model: config.fallbackModel,
            isFallback: true,
            reason: "critical_quota_zone",
          };
        }
      }

      // Check rate-limit incidents from DB
      if (quota.rateLimitIncidents >= RATE_LIMIT_THRESHOLD && config.allowFallbackOnRateLimit) {
        logger.info(
          { agentId, agentName, incidents: quota.rateLimitIncidents },
          "routing to fallback: rate-limit incidents from DB",
        );
        return {
          provider: config.fallbackProvider,
          model: config.fallbackModel,
          isFallback: true,
          reason: "rate_limit_incidents",
        };
      }

      // Primary provider is fine
      return {
        provider: config.primaryProvider,
        model: config.primaryModel,
        isFallback: false,
        reason: "primary_available",
      };
    },

    /**
     * Record a rate-limit event. Called when a heartbeat run fails
     * with a rate-limit error.
     */
    recordRateLimitEvent(companyId: string, provider: string): void {
      const key = `${companyId}:${provider}`;
      const existing = rateLimitCache.get(key);
      if (existing) {
        existing.count++;
        existing.lastSeen = new Date();
      } else {
        rateLimitCache.set(key, { count: 1, lastSeen: new Date() });
      }
    },

    /**
     * Check whether a specific action type is allowed on a fallback provider.
     */
    isActionAllowedOnFallback(actionType: string): boolean {
      return !FALLBACK_DENIED_ACTIONS.has(actionType);
    },

    /**
     * Check whether an agent should be paused during quota exhaustion.
     * Non-critical agents should be paused to preserve quota for critical work.
     */
    shouldPauseDuringQuotaExhaustion(agentRole: string): boolean {
      const normalizedRole = agentRole.toLowerCase().replace(/\s+/g, "_");
      return !FALLBACK_DENIED_ROLES.has(normalizedRole) && FALLBACK_ALLOWED_ROLES.has(normalizedRole);
    },

    /**
     * Get provider analytics for board exports.
     */
    async getProviderAnalytics(
      companyId: string,
      windowDays: number = 30,
    ): Promise<{
      providerBreakdown: Array<{ provider: string; model: string; totalCents: number; totalTokens: number; runCount: number }>;
      fallbackRuns: number;
      rateLimitIncidents: number;
      topAgents: Array<{ agentId: string; totalCents: number }>;
    }> {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - windowDays);

      // Provider/model breakdown
      const breakdown = await db
        .select({
          provider: costEvents.provider,
          model: costEvents.model,
          totalCents: sql<number>`COALESCE(SUM(${costEvents.costCents}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${costEvents.inputTokens} + ${costEvents.outputTokens}), 0)`,
          runCount: sql<number>`COUNT(DISTINCT ${costEvents.heartbeatRunId})`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, windowStart),
          ),
        )
        .groupBy(costEvents.provider, costEvents.model)
        .orderBy(desc(sql`SUM(${costEvents.costCents})`));

      // Count fallback runs (runs where error_code indicates fallback was used)
      const [fallbackResult] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, windowStart),
            sql`${heartbeatRuns.resultJson}->>'fallbackUsed' = 'true'`,
          ),
        );

      // Rate-limit incidents
      const [rateLimitResult] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.errorCode, "rate_limited"),
            gte(heartbeatRuns.finishedAt, windowStart),
          ),
        );

      // Top token-consuming agents
      const topAgents = await db
        .select({
          agentId: costEvents.agentId,
          totalCents: sql<number>`COALESCE(SUM(${costEvents.costCents}), 0)`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, windowStart),
          ),
        )
        .groupBy(costEvents.agentId)
        .orderBy(desc(sql`SUM(${costEvents.costCents})`))
        .limit(10);

      return {
        providerBreakdown: breakdown.map((r) => ({
          provider: r.provider,
          model: r.model,
          totalCents: r.totalCents,
          totalTokens: r.totalTokens,
          runCount: r.runCount,
        })),
        fallbackRuns: fallbackResult?.count ?? 0,
        rateLimitIncidents: rateLimitResult?.count ?? 0,
        topAgents: topAgents.map((r) => ({
          agentId: r.agentId,
          totalCents: r.totalCents,
        })),
      };
    },
  };
}
