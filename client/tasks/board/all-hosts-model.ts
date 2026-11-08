import type { TasksHandle } from "../data";
import { LANE_ORDER, settledAt, type LaneId, type TaskCard } from "../model";

/** A host is always identified by its configured Paseo serverId, never by its display label. */
export interface AggregateHost {
  serverId: string;
  label: string;
}

export interface AggregateTask {
  key: string;
  serverId: string;
  hostLabel: string;
  card: TaskCard;
}

/** SDK-owned host snapshots, kept apart so repeated agent ids cannot collide. */
export type HostTaskSnapshots = Readonly<Record<string, Pick<TasksHandle, "lanes" | "ready">>>;

export type AggregateLanes = Record<LaneId, AggregateTask[]>;

function matchesQuery(item: AggregateTask, query: string): boolean {
  if (!query) return true;
  const { card } = item;
  return [
    item.hostLabel,
    card.title,
    card.id,
    card.provider,
    card.providerLabel,
    card.model,
    card.modelLabel,
    card.location.projectName,
    card.location.workspaceName,
    card.location.branch,
    card.location.cwd,
    ...card.labels.map((label) => label.name),
  ].some((value) => value?.toLocaleLowerCase().includes(query));
}

function sortTimestamp(card: TaskCard): number {
  // Daemons can bump updatedAt while restoring a closed agent. Keep settled
  // and archived tasks in their true historical position instead.
  const time = card.lane === "archived"
    ? card.timing.archivedAt ?? settledAt(card.timing)
    : card.lane === "done" ? settledAt(card.timing)
    : card.lane === "needs_input" ? card.timing.attentionAt ?? card.timing.updatedAt
    : card.timing.updatedAt;
  const timestamp = Date.parse(time);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function aggregateHostTasks(
  hosts: readonly AggregateHost[],
  snapshots: HostTaskSnapshots,
  hostFilter: string | null,
  searchQuery: string,
): AggregateLanes {
  const lanes: AggregateLanes = {
    needs_input: [],
    running: [],
    review: [],
    done: [],
    archived: [],
  };
  const query = searchQuery.trim().toLocaleLowerCase();
  for (const host of hosts) {
    if (hostFilter && host.serverId !== hostFilter) continue;
    const snapshot = snapshots[host.serverId];
    if (!snapshot?.ready) continue;
    for (const lane of LANE_ORDER) {
      for (const card of snapshot.lanes[lane].cards) {
        const item: AggregateTask = {
          key: JSON.stringify([host.serverId, card.id]),
          serverId: host.serverId,
          hostLabel: host.label,
          card,
        };
        if (matchesQuery(item, query)) lanes[lane].push(item);
      }
    }
  }
  for (const lane of LANE_ORDER) {
    lanes[lane].sort((a, b) => sortTimestamp(b.card) - sortTimestamp(a.card) ||
      a.serverId.localeCompare(b.serverId) || a.card.id.localeCompare(b.card.id));
  }
  return lanes;
}
