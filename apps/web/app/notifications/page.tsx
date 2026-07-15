"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// =======================================================================
// Types
// =======================================================================
type NotificationType =
  | "ASSET_ASSIGNED"
  | "MAINTENANCE_APPROVED"
  | "MAINTENANCE_REJECTED"
  | "BOOKING_CONFIRMED"
  | "BOOKING_CANCELLED"
  | "BOOKING_REMINDER"
  | "TRANSFER_REQUESTED"
  | "TRANSFER_APPROVED"
  | "TRANSFER_REJECTED"
  | "OVERDUE_RETURN_ALERT"
  | "OVERDUE_BOOKING_ALERT"
  | "AUDIT_DISCREPANCY_FLAGGED"
  | "AUDIT_CYCLE_CLOSED"
  | "GENERAL";

type NotificationCategory = "bookings" | "approvals" | "alerts";

// Every notification type maps to exactly one sub-tab. Anything not
// booking- or approval-specific falls into Alerts as the catch-all.
const CATEGORY_BY_TYPE: Record<NotificationType, NotificationCategory> = {
  BOOKING_CONFIRMED: "bookings",
  BOOKING_CANCELLED: "bookings",
  BOOKING_REMINDER: "bookings",
  OVERDUE_BOOKING_ALERT: "bookings",
  MAINTENANCE_APPROVED: "approvals",
  MAINTENANCE_REJECTED: "approvals",
  TRANSFER_REQUESTED: "approvals",
  TRANSFER_APPROVED: "approvals",
  TRANSFER_REJECTED: "approvals",
  ASSET_ASSIGNED: "alerts",
  OVERDUE_RETURN_ALERT: "alerts",
  AUDIT_DISCREPANCY_FLAGGED: "alerts",
  AUDIT_CYCLE_CLOSED: "alerts",
  GENERAL: "alerts",
};

const CATEGORY_DOT: Record<NotificationCategory, string> = {
  bookings: "bg-blue-500",
  approvals: "bg-amber-500",
  alerts: "bg-red-500",
};

type Notification = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
};

type EmployeeOption = { id: string; name: string; email: string; role: string };

type ActivityLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  user: { id: string; name: string; email: string; role: string };
};

function formatDateTime(d: string) {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const PAGE_TABS = ["notifications", "activity"] as const;
type PageTab = (typeof PAGE_TABS)[number];

// =======================================================================
// Main page
// =======================================================================
export default function NotificationsPage() {
  const { user } = useAuth();
  const isManagerOrAdmin = ["ADMIN", "ASSET_MANAGER"].includes(user?.role ?? "");
  const [pageTab, setPageTab] = useState<PageTab>("notifications");

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-semibold mb-1">Notifications</h1>
        <p className="text-sm text-slate-500 mb-6">Keep every role informed without digging for updates.</p>

        {isManagerOrAdmin && (
          <div className="flex gap-2 mb-6 border-b border-slate-200">
            <PageTabButton active={pageTab === "notifications"} onClick={() => setPageTab("notifications")}>
              My Notifications
            </PageTabButton>
            <PageTabButton active={pageTab === "activity"} onClick={() => setPageTab("activity")}>
              Activity Log
            </PageTabButton>
          </div>
        )}

        {pageTab === "notifications" && <NotificationsPanel />}
        {pageTab === "activity" && isManagerOrAdmin && <ActivityLogPanel />}
      </div>
    </AppShell>
  );
}

function PageTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
        active ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// =======================================================================
// Notifications panel — All / Bookings / Alerts / Approvals
// =======================================================================
const NOTIF_TABS: { key: "all" | NotificationCategory; label: string }[] = [
  { key: "all", label: "All" },
  { key: "bookings", label: "Bookings" },
  { key: "alerts", label: "Alerts" },
  { key: "approvals", label: "Approvals" },
];

function NotificationsPanel() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<"all" | NotificationCategory>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    api<{ total: number; unreadCount: number; notifications: Notification[] }>("/notifications", {
      query: { isRead: unreadOnly ? "false" : undefined, pageSize: 100 },
    })
      .then((res) => {
        setNotifications(res.notifications);
        setUnreadCount(res.unreadCount);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load notifications"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [unreadOnly]);

  async function markAllRead() {
    setMarkingAll(true);
    try {
      await api("/notifications/read-all", { method: "POST" });
      load();
    } catch {
      // load() below will surface any lingering unread state either way
    } finally {
      setMarkingAll(false);
    }
  }

  const filtered = tab === "all" ? notifications : notifications.filter((n) => CATEGORY_BY_TYPE[n.type] === tab);

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center justify-between mb-5">
        <div className="flex gap-2">
          {NOTIF_TABS.map((t) => (
            <FilterPill key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </FilterPill>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
            Unread only {unreadCount > 0 && <span className="text-slate-400">({unreadCount})</span>}
          </label>
          <button onClick={markAllRead} disabled={markingAll || unreadCount === 0} className="btn-secondary text-xs px-3 py-1.5">
            {markingAll ? "Marking..." : "Mark all read"}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm text-slate-500">Nothing here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((n) => (
            <NotificationRow key={n.id} notification={n} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium ${
        active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function NotificationRow({ notification, onChanged }: { notification: Notification; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const category = CATEGORY_BY_TYPE[notification.type];

  async function markRead() {
    setBusy(true);
    try {
      await api(`/notifications/${notification.id}/read`, { method: "POST" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await api(`/notifications/${notification.id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`card p-4 flex items-start gap-3 ${notification.isRead ? "opacity-60" : ""}`}>
      <span className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${CATEGORY_DOT[category]}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="font-medium text-sm">{notification.title}</p>
          {!notification.isRead && <span className="badge badge-slate">New</span>}
        </div>
        <p className="text-sm text-slate-600 mt-0.5">{notification.message}</p>
        <p className="text-xs text-slate-400 mt-1.5">{formatDateTime(notification.createdAt)}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        {!notification.isRead && (
          <button onClick={markRead} disabled={busy} className="text-xs text-slate-500 hover:underline">
            Mark read
          </button>
        )}
        <button onClick={dismiss} disabled={busy} className="text-xs text-slate-400 hover:underline">
          Dismiss
        </button>
      </div>
    </div>
  );
}

// =======================================================================
// Activity Log panel — Admin / Asset Manager only
// =======================================================================
function ActivityLogPanel() {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    api<{ actions: string[] }>("/activity-logs/actions").then((res) => setActions(res.actions)).catch(() => setActions([]));
    api<EmployeeOption[]>("/users").then(setEmployees).catch(() => setEmployees([]));
  }, []);

  function load() {
    setLoading(true);
    setError(null);
    api<{ total: number; logs: ActivityLog[] }>("/activity-logs", {
      query: {
        userId: userId || undefined,
        action: action || undefined,
        entityType: entityType || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize,
      },
    })
      .then((res) => {
        setLogs(res.logs);
        setTotal(res.total);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load activity log"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [userId, action, entityType, from, to, page]);

  // Reset to page 1 whenever a filter changes (not on page itself).
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, action, entityType, from, to]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center">
        <select className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">All users</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <input
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Entity type (e.g. Asset)"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
        />
        <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : logs.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">No activity matches this filter.</div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <table>
              <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{formatDateTime(log.createdAt)}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{log.user.name}</p>
                      <p className="text-xs text-slate-400">{log.user.role}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="badge badge-slate">{log.action.replace(/_/g, " ")}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {log.entityType} <span className="text-xs text-slate-400 font-mono">{log.entityId.slice(0, 8)}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 max-w-xs truncate">
                      {log.metadata ? JSON.stringify(log.metadata) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between items-center mt-4 text-sm text-slate-500">
            <p>
              {total} total entr{total === 1 ? "y" : "ies"}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Previous
              </button>
              <span className="text-xs text-slate-400 self-center">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
