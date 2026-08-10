import { useEffect, useMemo } from "react";
import { Link, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { missionApi } from "../api/mission";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Card } from "@/components/ui/card";
import { ActivityRow } from "../components/ActivityRow";
import { StatusGlyph } from "../components/StatusGlyph";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  GanttChart,
  Hourglass,
  MessageSquare,
  Play,
  ShieldCheck,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import type { MissionView, MissionAttentionEntry } from "@paperclipai/shared";

function stateIcon(state: string) {
  switch (state) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4" style={{ color: "var(--status-task-done)" }} />;
    case "failed":
    case "blocked":
      return <XCircle className="h-4 w-4" style={{ color: "var(--status-task-blocked)" }} />;
    case "waiting_for_human":
      return <Hourglass className="h-4 w-4" style={{ color: "var(--status-task-todo)" }} />;
    case "verifying":
      return <ShieldCheck className="h-4 w-4" style={{ color: "var(--status-task-in_review)" }} />;
    case "running":
      return <Play className="h-4 w-4" style={{ color: "var(--status-task-in_progress)" }} />;
    default:
      return <Clock className="h-4 w-4" style={{ color: "var(--status-task-backlog)" }} />;
  }
}

function stateLabel(state: string) {
  switch (state) {
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "blocked": return "Blocked";
    case "waiting_for_human": return "Waiting for human";
    case "verifying": return "Verifying";
    case "running": return "Running";
    default: return "Planned";
  }
}

function ageToDate(ageMs: number): Date | string {
  return new Date(Date.now() - ageMs);
}

function AttentionBadge({ item }: { item: MissionAttentionEntry }) {
  const icon = item.kind === "question"
    ? <MessageSquare className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
    : item.kind === "approval"
    ? <ShieldCheck className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
    : item.kind === "blocker"
    ? <XCircle className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
    : item.kind === "verification_failure"
    ? <AlertTriangle className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
    : item.kind === "action_required"
    ? <CircleAlert className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
    : <Clock className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />;

  const content = (
    <div
      className={cn(
        "flex items-start py-1.5 px-2 text-sm rounded-(--radius-sm)",
        item.priority === "high" && "bg-red-50 dark:bg-red-950/20",
        item.priority === "medium" && "bg-amber-50 dark:bg-amber-950/20",
        item.priority === "low" && "bg-muted/50",
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{item.title}</div>
        {item.description && (
          <div className="text-xs text-muted-foreground mt-0.5">{item.description}</div>
        )}
        <div className="text-(length:--text-nano) text-muted-foreground/70 mt-0.5">
          {timeAgo(ageToDate(item.ageMs))}
        </div>
      </div>
    </div>
  );

  if (item.route) {
    return <Link to={item.route} className="block">{content}</Link>;
  }
  return content;
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 bg-muted rounded-(--radius-sm) flex-1 overflow-hidden">
        <div
          className="h-full rounded-(--radius-sm) transition-all duration-300"
          style={{
            width: `${pct}%`,
            backgroundColor: "var(--status-task-done)",
          }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}

export function MissionControl() {
  const { issueId } = useParams<{ issueId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: mission, isLoading, error } = useQuery({
    queryKey: ["mission", selectedCompanyId, issueId],
    queryFn: () => missionApi.get(selectedCompanyId!, issueId!),
    enabled: !!selectedCompanyId && !!issueId,
  });

  useEffect(() => {
    if (mission) {
      setBreadcrumbs([
        { label: "Mission Control", href: "/mission" },
        { label: mission.objective },
      ]);
    }
  }, [setBreadcrumbs, mission, issueId]);

  const { data: agents } = useQuery({
    queryKey: ["agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );
  const entityNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.id, a.name);
    return m;
  }, [agents]);
  const entityTitleMap = useMemo(() => {
    const m = new Map<string, string>();
    if (mission) {
      m.set(mission.missionId, mission.objective);
      for (const w of mission.activeWork) m.set(w.issue.id, w.issue.title);
      for (const i of mission.recentlyCompleted) m.set(i.id, i.title);
    }
    return m;
  }, [mission]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={GanttChart}
        message="Select a company to view mission control."
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error || !mission) {
    return (
      <EmptyState
        icon={CircleAlert}
        message="Could not load mission"
        description={(error as Error)?.message ?? "The mission may not exist or you may not have access."}
      />
    );
  }

  const totalAttention =
    mission.humanAttention.actionRequired.length +
    mission.humanAttention.questionsWaiting.length +
    mission.humanAttention.approvalsPending.length +
    mission.humanAttention.blocked.length +
    mission.humanAttention.verificationFailures.length;

  const statusVar = mission.state === "waiting_for_human" ? "todo"
    : mission.state === "blocked" || mission.state === "failed" ? "blocked"
    : mission.state === "verifying" ? "in_review"
    : mission.state === "running" ? "in_progress"
    : mission.state === "completed" ? "done"
    : "backlog";

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          {stateIcon(mission.state)}
          <h1 className="text-lg font-semibold text-foreground">{mission.objective}</h1>
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-(--radius-sm) whitespace-nowrap"
            style={{
              backgroundColor: `color-mix(in oklch, var(--status-task-${statusVar}) 15%, transparent)`,
              color: `var(--status-task-icon-${statusVar})`,
            }}
          >
            {stateLabel(mission.state)}
          </span>
          <span className="text-xs text-muted-foreground">{mission.phase}</span>
        </div>
        {mission.description && (
          <p className="text-sm text-muted-foreground max-w-3xl">{mission.description}</p>
        )}
      </div>

      {totalAttention > 0 && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CircleAlert className="h-4 w-4" style={{ color: "var(--status-task-blocked)" }} />
            <h2 className="text-sm font-semibold text-foreground">
              Human Attention Required ({totalAttention})
            </h2>
          </div>

          {mission.humanAttention.actionRequired.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--status-task-blocked)" }}>
                Action Required
              </div>
              <div className="space-y-1">
                {mission.humanAttention.actionRequired.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}

          {mission.humanAttention.questionsWaiting.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--status-task-icon-todo)" }}>
                Questions Awaiting Answer ({mission.humanAttention.questionsWaiting.length})
              </div>
              <div className="space-y-1">
                {mission.humanAttention.questionsWaiting.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}

          {mission.humanAttention.approvalsPending.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--status-task-in_review)" }}>
                Approvals Pending ({mission.humanAttention.approvalsPending.length})
              </div>
              <div className="space-y-1">
                {mission.humanAttention.approvalsPending.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}

          {mission.humanAttention.blocked.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--status-task-blocked)" }}>
                Blocked Work ({mission.humanAttention.blocked.length})
              </div>
              <div className="space-y-1">
                {mission.humanAttention.blocked.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}

          {mission.humanAttention.verificationFailures.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--status-task-icon-todo)" }}>
                Verification Issues ({mission.humanAttention.verificationFailures.length})
              </div>
              <div className="space-y-1">
                {mission.humanAttention.verificationFailures.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}

          {mission.humanAttention.informational.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
                Informational ({mission.humanAttention.informational.length})
              </div>
              <div className="space-y-1">
                {mission.humanAttention.informational.map((item) => (
                  <AttentionBadge key={item.sourceId} item={item} />
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Progress</h2>
          <ProgressBar
            value={mission.progress.completedTasks}
            max={mission.progress.totalTasks}
          />
          <div className="grid grid-cols-5 gap-2 text-center">
            {[
              { label: "Total", count: mission.progress.totalTasks },
              { label: "Done", count: mission.progress.completedTasks, color: "var(--status-task-done)" },
              { label: "Active", count: mission.progress.inProgressTasks, color: "var(--status-task-in_progress)" },
              { label: "Review", count: mission.progress.inReviewTasks, color: "var(--status-task-in_review)" },
              { label: "Blocked", count: mission.progress.blockedTasks, color: "var(--status-task-blocked)" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-lg font-bold" style={s.color ? { color: s.color } : undefined}>
                  {s.count}
                </div>
                <div className="text-(length:--text-nano) text-muted-foreground uppercase tracking-wide">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Budget</h2>
          {mission.budget ? (
            <>
              <div className="text-2xl font-bold text-foreground tabular-nums">
                {formatCents(mission.budget.spentCents)}
              </div>
              <div className="text-xs text-muted-foreground">{mission.budget.label}</div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No budget information available</div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {mission.activeWork.length > 0 && (
          <Card className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Active Work</h2>
            <div className="space-y-2">
              {mission.activeWork.map((w) => (
                <Link
                  key={w.issue.id}
                  to={`/issues/${w.issue.id}`}
                  className="flex items-center gap-2 p-2 hover:bg-muted/50 rounded-(--radius-sm)"
                >
                  <StatusGlyph size="sm" status={w.issue.status} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">
                      {w.issue.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {w.assigneeName ?? "Unassigned"}
                      {w.lastActivityAt && ` \u00b7 ${timeAgo(new Date(w.lastActivityAt))}`}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        )}

        {mission.recentlyCompleted.length > 0 && (
          <Card className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-foreground">Recently Completed</h2>
            <div className="space-y-2">
              {mission.recentlyCompleted.map((i) => (
                <Link
                  key={i.id}
                  to={`/issues/${i.id}`}
                  className="flex items-center gap-2 p-2 hover:bg-muted/50 rounded-(--radius-sm)"
                >
                  <StatusGlyph size="sm" status="done" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground truncate">{i.title}</div>
                    {i.completedAt && (
                      <div className="text-xs text-muted-foreground">
                        Completed {timeAgo(new Date(i.completedAt))}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        )}
      </div>

      {mission.blockers.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Blockers</h2>
          <div className="space-y-2">
            {mission.blockers.map((b) => (
              <div key={b.issue.id} className="flex items-start gap-2 p-2">
                <StatusGlyph size="sm" status="blocked" />
                <div className="min-w-0 flex-1">
                  <Link to={`/issues/${b.issue.id}`} className="text-sm font-medium text-foreground hover:underline">
                    {b.issue.title}
                  </Link>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Blocked by:{" "}
                    {b.blockedBy.map((bi, j) => (
                      <span key={bi.id}>
                        {j > 0 && ", "}
                        <Link to={`/issues/${bi.id}`} className="hover:underline">
                          {bi.title}
                        </Link>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {mission.unansweredQuestions.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Unanswered Questions</h2>
          <div className="space-y-3">
            {mission.unansweredQuestions.map((q) => {
              const interaction = q.interaction as { title?: string | null; summary?: string | null; id: string };
              return (
                <div key={interaction.id} className="space-y-1">
                  <Link
                    to={`/issues/${q.issue.id}`}
                    className="text-sm font-medium text-foreground hover:underline"
                  >
                    {interaction.title ?? "Question"}
                  </Link>
                  {interaction.summary && (
                    <p className="text-xs text-muted-foreground">{interaction.summary}</p>
                  )}
                  <div className="text-(length:--text-nano) text-muted-foreground/70">
                    On {q.issueIdentifier ? `#${q.issueIdentifier}` : q.issue.title}
                    {" \u00b7 "}
                    {timeAgo(ageToDate(q.ageMs))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {mission.pendingApprovals.length > 0 && (
        <Card className="p-4 space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Pending Approvals</h2>
          <div className="space-y-2">
            {mission.pendingApprovals.map((a) => (
              <Link
                key={a.approval.id}
                to={`/approvals/${a.approval.id}`}
                className="flex items-start gap-2 p-2 hover:bg-muted/50 rounded-(--radius-sm)"
              >
                <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: "var(--status-task-in_review)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">
                    Approval: {(a.approval as { type: string }).type.replace(/_/g, " ")}
                  </div>
                  {a.issues.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {a.issues.map((i) => i.title).join(", ")}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Verification</h2>
        {mission.verification.overallStatus === "unknown" && (
          <div className="flex items-start gap-2">
            <Clock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Not yet verified</div>
              {mission.verification.note && (
                <div className="text-xs text-muted-foreground/70 mt-0.5">{mission.verification.note}</div>
              )}
            </div>
          </div>
        )}
        {mission.verification.overallStatus === "in_progress" && (
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: "var(--status-task-in_review)" }} />
            <div>
              <div className="text-sm" style={{ color: "var(--status-task-in_review)" }}>Verification in progress</div>
              {mission.verification.note && (
                <div className="text-xs text-muted-foreground/70 mt-0.5">{mission.verification.note}</div>
              )}
            </div>
          </div>
        )}
      </Card>

      {mission.recentActivity.length > 0 && (
        <Card className="p-4 space-y-0 divide-y divide-border">
          <h2 className="text-sm font-semibold text-foreground pb-3">Recent Activity</h2>
          {mission.recentActivity.map((event) => (
            <ActivityRow
              key={event.id}
              event={event}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
              userProfileMap={undefined}
            />
          ))}
        </Card>
      )}
    </div>
  );
}
