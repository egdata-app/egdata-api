import {
  AlertCircle,
  FolderKanban,
  KeyRound,
  MoreHorizontal,
  Search,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Menu, MenuItem, MenuTrigger } from "react-aria-components";
import type { AdminUsage } from "../../worker/admin-types";
import { adminDate, usageNumber } from "./AdminShared";
import { Button } from "./ui/Button";
import { Popover } from "./ui/Modal";

export function AdminIdentity({
  name,
  detail,
  kind,
  badge,
  children,
}: {
  name: string;
  detail: string;
  kind: "user" | "project";
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 min-w-56 max-w-80">
      <div
        aria-hidden="true"
        className={`flex items-center justify-center shrink-0 w-9 h-9 rounded-lg border ${kind === "user" ? "bg-epic-accent-muted border-epic-accent/15 text-epic-accent" : "bg-epic-elevated border-epic-border text-epic-text-muted"}`}
      >
        {kind === "user" ? (
          <span className="text-xs font-semibold uppercase">
            {name.trim().slice(0, 2) || <Users className="w-4 h-4" />}
          </span>
        ) : (
          <FolderKanban className="w-4 h-4" />
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium" title={name}>
            {name}
          </span>
          {badge}
        </div>
        <div className="truncate text-xs text-epic-text-muted" title={detail}>
          {detail}
        </div>
        {children}
      </div>
    </div>
  );
}

export function AdminKeyCount({
  active,
  total,
}: {
  active: number;
  total: number;
}) {
  return (
    <div className="space-y-1 whitespace-nowrap">
      <div
        className={`flex items-center gap-1.5 font-mono text-xs tabular-nums ${active ? "text-epic-success" : "text-epic-text-muted"}`}
      >
        <KeyRound aria-hidden="true" className="w-3 h-3" />
        {active.toLocaleString()} <span className="font-sans">active</span>
      </div>
      <div className="text-[11px] text-epic-text-muted">
        {total.toLocaleString()} total keys
      </div>
    </div>
  );
}

export function AdminRequestCount({
  usage,
  id,
}: {
  usage: AdminUsage;
  id: string;
}) {
  const requests = usage.byId[id]?.requests;
  return (
    <span
      className={`font-mono text-xs tabular-nums ${requests ? "text-epic-text" : "text-epic-text-muted"}`}
    >
      {usageNumber(usage, id, "requests")}
    </span>
  );
}

export function AdminErrorCounts({
  usage,
  id,
}: {
  usage: AdminUsage;
  id: string;
}) {
  const metrics = usage.byId[id];
  if (!metrics)
    return <span className="text-xs text-epic-text-muted">Unavailable</span>;
  return (
    <div className="space-y-1 whitespace-nowrap text-xs">
      <div className="flex items-center gap-2">
        <span
          className={`font-mono tabular-nums ${metrics.rateLimited ? "text-epic-warning" : "text-epic-text-muted"}`}
        >
          {metrics.rateLimited.toLocaleString()}
        </span>
        <span className="text-[11px] text-epic-text-muted">429s</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`font-mono tabular-nums ${metrics.errors ? "text-epic-danger" : "text-epic-text-muted"}`}
        >
          {metrics.errors.toLocaleString()}
        </span>
        <span className="text-[11px] text-epic-text-muted">errors</span>
      </div>
    </div>
  );
}

export function AdminLastUsed({ value }: { value: string | null }) {
  if (!value)
    return <span className="text-xs text-epic-text-muted">Never used</span>;
  const date = new Date(value);
  return (
    <time
      dateTime={value}
      title={adminDate(value)}
      className="block space-y-1 whitespace-nowrap text-xs"
    >
      <span className="block">
        {date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}
      </span>
      <span className="block font-mono text-[11px] text-epic-text-muted">
        {date.toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
    </time>
  );
}

export function AdminRowActions({
  label,
  actions,
}: {
  label: string;
  actions: {
    id: string;
    label: string;
    icon: ReactNode;
    onAction: () => void;
    disabled?: boolean;
    destructive?: boolean;
  }[];
}) {
  return (
    <MenuTrigger>
      <Button variant="icon" aria-label={`Actions for ${label}`}>
        <MoreHorizontal aria-hidden="true" className="w-4 h-4" />
      </Button>
      <Popover placement="bottom end">
        <Menu
          aria-label={`Actions for ${label}`}
          className="min-w-44 p-1 outline-0"
          items={actions}
        >
          {(action) => (
            <MenuItem
              id={action.id}
              textValue={action.label}
              onAction={action.onAction}
              isDisabled={action.disabled}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs outline-0 cursor-pointer focused:bg-epic-hover disabled:opacity-40 disabled:cursor-not-allowed ${action.destructive ? "text-epic-danger" : "text-epic-text"}`}
            >
              <span aria-hidden="true">{action.icon}</span>
              {action.label}
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

export function AdminTableState({
  loading,
  error,
  noun,
  filtered,
  retry,
}: {
  loading: boolean;
  error: string;
  noun: "users" | "projects";
  filtered: boolean;
  retry: () => void;
}) {
  if (loading)
    return (
      <div className="py-12 px-6">
        <div
          aria-hidden="true"
          className="mx-auto max-w-lg space-y-4 motion-safe:animate-pulse"
        >
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-lg bg-epic-elevated" />
              <div className="h-3 flex-1 rounded bg-epic-elevated" />
              <div className="h-3 w-16 rounded bg-epic-elevated" />
            </div>
          ))}
        </div>
        <output className="block mt-5 text-xs text-epic-text-muted">
          Loading {noun}…
        </output>
      </div>
    );
  const Icon = error ? AlertCircle : Search;
  return (
    <div className="py-14 px-6 space-y-3 text-center">
      <Icon
        aria-hidden="true"
        className={`w-6 h-6 mx-auto ${error ? "text-epic-danger" : "text-epic-text-muted"}`}
      />
      <p
        role={error ? "alert" : "status"}
        className="font-medium text-sm text-epic-text"
      >
        {error ? `Could not load ${noun}` : `No ${noun} found`}
      </p>
      <p className="text-xs text-epic-text-muted max-w-md mx-auto">
        {error ||
          (filtered
            ? "Try a different search or clear your filters."
            : `There are no ${noun} to display yet.`)}
      </p>
      {error && (
        <Button size="sm" variant="secondary" onPress={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
