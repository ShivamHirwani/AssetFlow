"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StatusBadge } from "@/lib/status-badge";

// =======================================================================
// Types
// =======================================================================
type AuditCycleStatus = "PLANNED" | "IN_PROGRESS" | "CLOSED";
type AuditItemStatus = "PENDING" | "VERIFIED" | "MISSING" | "DAMAGED";

type PersonRef = { id: string; name: string; email?: string };

type AuditCycle = {
  id: string;
  name: string;
  scopeDepartmentId: string | null;
  scopeLocation: string | null;
  startDate: string;
  endDate: string;
  status: AuditCycleStatus;
  closedAt: string | null;
  createdAt: string;
  createdBy: PersonRef;
  auditors: { auditor: PersonRef }[];
  _count: { items: number };
};

type AuditCycleDetail = Omit<AuditCycle, "_count"> & {
  scopeDepartment: { id: string; name: string } | null;
  itemSummary: Record<AuditItemStatus, number>;
};

type AuditItem = {
  id: string;
  auditCycleId: string;
  status: AuditItemStatus;
  discrepancyNote: string | null;
  recordedAt: string | null;
  asset: { id: string; assetTag: string; name: string; location: string; status: string };
  recordedBy: PersonRef | null;
};

type DepartmentOption = { id: string; name: string };
type EmployeeOption = { id: string; name: string; email: string; role: string };

const CYCLE_STATUS_LABEL: Record<AuditCycleStatus, string> = {
  PLANNED: "Planned",
  IN_PROGRESS: "In Progress",
  CLOSED: "Closed",
};

const ITEM_STATUS_ORDER: AuditItemStatus[] = ["PENDING", "VERIFIED", "MISSING", "DAMAGED"];

function formatDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// =======================================================================
// Main page — list of cycles, or the detail view for one selected cycle
// =======================================================================
export default function AuditsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (selectedId) {
    return <AuditCycleDetailView id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return <AuditCycleList isAdmin={isAdmin} onSelect={setSelectedId} />;
}

// =======================================================================
// List view
// =======================================================================
function AuditCycleList({ isAdmin, onSelect }: { isAdmin: boolean; onSelect: (id: string) => void }) {
  const [cycles, setCycles] = useState<AuditCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AuditCycleStatus | "">("");
  const [showForm, setShowForm] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    api<{ auditCycles: AuditCycle[] }>("/audits", {
      query: { status: statusFilter || undefined, pageSize: 100 },
    })
      .then((res) => setCycles(res.auditCycles))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load audit cycles"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [statusFilter]);

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-8">
        <div className="flex justify-between items-start mb-1">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Audit</h1>
            <p className="text-sm text-slate-500">
              Run structured verification cycles and catch discrepancies before they become losses.
            </p>
          </div>
          {isAdmin && (
            <button onClick={() => setShowForm(!showForm)} className="btn-primary">
              {showForm ? "Cancel" : "+ Create Audit Cycle"}
            </button>
          )}
        </div>

        {showForm && (
          <CreateAuditCycleForm
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        )}

        <div className="card p-4 mt-6 mb-5 flex flex-wrap gap-2 items-center">
          <FilterPill active={statusFilter === ""} onClick={() => setStatusFilter("")}>
            All
          </FilterPill>
          {(["PLANNED", "IN_PROGRESS", "CLOSED"] as AuditCycleStatus[]).map((s) => (
            <FilterPill key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {CYCLE_STATUS_LABEL[s]}
            </FilterPill>
          ))}
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : cycles.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-slate-500">No audit cycles match this filter.</p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table>
              <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Cycle</th>
                  <th className="px-4 py-3">Scope</th>
                  <th className="px-4 py-3">Date Range</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Auditors</th>
                  <th className="px-4 py-3">Assets</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {cycles.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-slate-400">Created by {c.createdBy.name}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.scopeDepartmentId ? "Department" : c.scopeLocation ? `Location: ${c.scopeLocation}` : "Organization-wide"}
                    </td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                      {formatDate(c.startDate)} – {formatDate(c.endDate)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.auditors.length === 0 ? (
                        <span className="text-slate-300">None</span>
                      ) : (
                        c.auditors.map((a) => a.auditor.name).join(", ")
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{c._count.items}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => onSelect(c.id)} className="btn-secondary text-xs px-3 py-1.5">
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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

// =======================================================================
// Create Audit Cycle form (Admin only)
// =======================================================================
function CreateAuditCycleForm({ onCreated }: { onCreated: () => void }) {
  const [scopeMode, setScopeMode] = useState<"org" | "department" | "location">("org");
  const [name, setName] = useState("");
  const [scopeDepartmentId, setScopeDepartmentId] = useState("");
  const [scopeLocation, setScopeLocation] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [auditorIds, setAuditorIds] = useState<string[]>([]);

  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    api<DepartmentOption[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
    api<EmployeeOption[]>("/users").then(setEmployees).catch(() => setEmployees([]));
  }, []);

  function toggleAuditor(id: string) {
    setAuditorIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (auditorIds.length === 0) {
      setFormError("Assign at least one auditor.");
      return;
    }

    setSaving(true);
    try {
      await api("/audits", {
        method: "POST",
        body: {
          name,
          scopeDepartmentId: scopeMode === "department" ? scopeDepartmentId : null,
          scopeLocation: scopeMode === "location" ? scopeLocation : null,
          startDate,
          endDate,
          auditorIds,
        },
      });
      onCreated();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to create audit cycle");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 mt-6 space-y-4 max-w-2xl">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">New Audit Cycle</p>

      <input
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="Cycle name (e.g. Q3 2026 Electronics Audit)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <div>
        <p className="text-xs text-slate-500 mb-1.5">Scope</p>
        <div className="flex gap-2 text-xs mb-2">
          {(["org", "department", "location"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setScopeMode(mode)}
              className={`flex-1 py-1.5 rounded-md ${
                scopeMode === mode ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
              }`}
            >
              {mode === "org" ? "Organization-wide" : mode === "department" ? "Department" : "Location"}
            </button>
          ))}
        </div>
        {scopeMode === "department" && (
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={scopeDepartmentId}
            onChange={(e) => setScopeDepartmentId(e.target.value)}
            required
          >
            <option value="">Select department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {scopeMode === "location" && (
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Location (e.g. Building B, 2nd Floor)"
            value={scopeLocation}
            onChange={(e) => setScopeLocation(e.target.value)}
            required
          />
        )}
      </div>

      <div className="flex gap-3">
        <label className="flex-1 text-xs text-slate-500">
          Start date
          <input
            type="date"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            required
          />
        </label>
        <label className="flex-1 text-xs text-slate-500">
          End date
          <input
            type="date"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            required
          />
        </label>
      </div>

      <div>
        <p className="text-xs text-slate-500 mb-1.5">Assign auditors</p>
        <div className="max-h-40 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
          {employees.length === 0 && <p className="text-xs text-slate-300 p-3">No employees found</p>}
          {employees.map((emp) => (
            <label key={emp.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={auditorIds.includes(emp.id)}
                onChange={() => toggleAuditor(emp.id)}
              />
              <span className="flex-1">{emp.name}</span>
              <span className="text-xs text-slate-400">{emp.role}</span>
            </label>
          ))}
        </div>
      </div>

      {formError && <p className="text-sm text-red-600">{formError}</p>}
      <button type="submit" disabled={saving} className="btn-primary">
        {saving ? "Creating..." : "Create Audit Cycle"}
      </button>
    </form>
  );
}

// =======================================================================
// Detail view — checklist, discrepancies, auditors, close
// =======================================================================
function AuditCycleDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const isManagerOrAdmin = ["ADMIN", "ASSET_MANAGER"].includes(user?.role ?? "");

  const [cycle, setCycle] = useState<AuditCycleDetail | null>(null);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [discrepancies, setDiscrepancies] = useState<AuditItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"checklist" | "discrepancies" | "auditors">("checklist");
  const [itemStatusFilter, setItemStatusFilter] = useState<AuditItemStatus | "">("");

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      api<AuditCycleDetail>(`/audits/${id}`),
      api<AuditItem[]>(`/audits/${id}/items`),
      api<AuditItem[]>(`/audits/${id}/discrepancies`),
    ])
      .then(([c, i, d]) => {
        setCycle(c);
        setItems(i);
        setDiscrepancies(d);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load audit cycle"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  useEffect(() => {
    if (isAdmin) {
      api<EmployeeOption[]>("/users").then(setEmployees).catch(() => setEmployees([]));
    }
  }, [isAdmin]);

  const isAssignedAuditor = cycle?.auditors.some((a) => a.auditor.id === user?.id) ?? false;
  const canMark = cycle?.status !== "CLOSED" && (isManagerOrAdmin || isAssignedAuditor);
  const canManageAuditors = isAdmin && cycle?.status !== "CLOSED";
  const canClose = isManagerOrAdmin && cycle?.status !== "CLOSED";

  const filteredItems = itemStatusFilter ? items.filter((it) => it.status === itemStatusFilter) : items;

  if (loading) {
    return (
      <AppShell>
        <div className="max-w-6xl mx-auto p-8">
          <p className="text-sm text-slate-400">Loading...</p>
        </div>
      </AppShell>
    );
  }

  if (error || !cycle) {
    return (
      <AppShell>
        <div className="max-w-6xl mx-auto p-8">
          <button onClick={onBack} className="text-sm text-slate-500 hover:underline mb-4">
            ← Back to Audit
          </button>
          <p className="text-sm text-red-600">{error ?? "Audit cycle not found"}</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-8">
        <button onClick={onBack} className="text-sm text-slate-500 hover:underline mb-4">
          ← Back to Audit
        </button>

        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-semibold">{cycle.name}</h1>
              <StatusBadge status={cycle.status} />
            </div>
            <p className="text-sm text-slate-500">
              {cycle.scopeDepartment
                ? `Department: ${cycle.scopeDepartment.name}`
                : cycle.scopeLocation
                  ? `Location: ${cycle.scopeLocation}`
                  : "Organization-wide"}
              {" · "}
              {formatDate(cycle.startDate)} – {formatDate(cycle.endDate)}
              {" · "}Created by {cycle.createdBy.name}
            </p>
          </div>
          {canClose && <CloseCycleControl cycleId={cycle.id} itemSummary={cycle.itemSummary} onClosed={load} />}
        </div>

        <div className="grid grid-cols-4 gap-3 mt-6 mb-6">
          {ITEM_STATUS_ORDER.map((s) => (
            <div key={s} className="card p-4">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </p>
              <p className="text-2xl font-semibold">{cycle.itemSummary[s] ?? 0}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-2 mb-6 border-b border-slate-200">
          <DetailTabButton active={tab === "checklist"} onClick={() => setTab("checklist")}>
            Checklist
          </DetailTabButton>
          <DetailTabButton active={tab === "discrepancies"} onClick={() => setTab("discrepancies")}>
            Discrepancy Report{discrepancies.length > 0 ? ` (${discrepancies.length})` : ""}
          </DetailTabButton>
          <DetailTabButton active={tab === "auditors"} onClick={() => setTab("auditors")}>
            Auditors
          </DetailTabButton>
        </div>

        {tab === "checklist" && (
          <div>
            <div className="flex flex-wrap gap-2 mb-4">
              <FilterPill active={itemStatusFilter === ""} onClick={() => setItemStatusFilter("")}>
                All ({items.length})
              </FilterPill>
              {ITEM_STATUS_ORDER.map((s) => (
                <FilterPill key={s} active={itemStatusFilter === s} onClick={() => setItemStatusFilter(s)}>
                  {s.charAt(0) + s.slice(1).toLowerCase()} ({items.filter((it) => it.status === s).length})
                </FilterPill>
              ))}
            </div>

            {filteredItems.length === 0 ? (
              <div className="card p-8 text-center">
                <p className="text-sm text-slate-500">No assets in this filter.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredItems.map((item) => (
                  <AuditItemRow key={item.id} item={item} canMark={canMark} onChanged={load} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "discrepancies" && (
          <div className="space-y-3">
            {discrepancies.length === 0 ? (
              <div className="card p-8 text-center">
                <p className="text-sm text-slate-500">No discrepancies flagged yet.</p>
              </div>
            ) : (
              discrepancies.map((item) => (
                <div key={item.id} className="card p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-medium text-sm">{item.asset.name}</p>
                      <p className="text-xs text-slate-400 font-mono">
                        {item.asset.assetTag} · {item.asset.location}
                      </p>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                  {item.discrepancyNote && (
                    <p className="text-sm text-slate-600 mt-2 italic">"{item.discrepancyNote}"</p>
                  )}
                  <p className="text-xs text-slate-400 mt-2">
                    {item.recordedBy ? `Flagged by ${item.recordedBy.name}` : "Flagged"}
                    {item.recordedAt ? ` on ${formatDate(item.recordedAt)}` : ""}
                  </p>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "auditors" && (
          <AuditorsPanel
            cycle={cycle}
            employees={employees}
            canManage={canManageAuditors}
            onChanged={load}
          />
        )}
      </div>
    </AppShell>
  );
}

function DetailTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
// Item row — mark Verified / Missing / Damaged
// =======================================================================
function AuditItemRow({ item, canMark, onChanged }: { item: AuditItem; canMark: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flagMode, setFlagMode] = useState<"MISSING" | "DAMAGED" | null>(null);
  const [note, setNote] = useState("");

  async function mark(status: AuditItemStatus, discrepancyNote?: string) {
    setError(null);
    setBusy(true);
    try {
      await api(`/audits/${item.auditCycleId}/items/${item.id}/mark`, {
        method: "POST",
        body: { status, discrepancyNote },
      });
      setFlagMode(null);
      setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to mark asset");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm truncate">{item.asset.name}</p>
          <StatusBadge status={item.status} />
        </div>
        <p className="text-xs text-slate-400 font-mono">
          {item.asset.assetTag} · {item.asset.location}
        </p>
        {item.discrepancyNote && (
          <p className="text-xs text-slate-500 italic mt-1">"{item.discrepancyNote}"</p>
        )}
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>

      {canMark && (
        <div className="shrink-0">
          {flagMode ? (
            <div className="flex items-center gap-2">
              <input
                className="rounded-md border border-slate-300 px-2 py-1.5 text-xs w-48"
                placeholder="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
              />
              <button
                onClick={() => mark(flagMode, note || undefined)}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white"
              >
                Confirm
              </button>
              <button onClick={() => setFlagMode(null)} className="btn-secondary text-xs px-3 py-1.5">
                Back
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => mark("VERIFIED")}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md bg-emerald-600 text-white disabled:opacity-50"
              >
                Verified
              </button>
              <button
                onClick={() => setFlagMode("MISSING")}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-600 disabled:opacity-50"
              >
                Missing
              </button>
              <button
                onClick={() => setFlagMode("DAMAGED")}
                disabled={busy}
                className="text-xs px-3 py-1.5 rounded-md border border-orange-200 text-orange-600 disabled:opacity-50"
              >
                Damaged
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Auditors panel — add/remove (Admin only, non-closed cycles)
// =======================================================================
function AuditorsPanel({
  cycle,
  employees,
  canManage,
  onChanged,
}: {
  cycle: AuditCycleDetail;
  employees: EmployeeOption[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [addId, setAddId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignedIds = new Set(cycle.auditors.map((a) => a.auditor.id));
  const available = employees.filter((e) => !assignedIds.has(e.id));

  async function addAuditor() {
    if (!addId) return;
    setError(null);
    setBusy(true);
    try {
      await api(`/audits/${cycle.id}/auditors`, { method: "POST", body: { auditorIds: [addId] } });
      setAddId("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add auditor");
    } finally {
      setBusy(false);
    }
  }

  async function removeAuditor(auditorId: string) {
    setError(null);
    setBusy(true);
    try {
      await api(`/audits/${cycle.id}/auditors/${auditorId}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove auditor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5 max-w-xl">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">Assigned Auditors</p>
      {cycle.auditors.length === 0 && <p className="text-sm text-slate-400 mb-3">No auditors assigned.</p>}
      <div className="space-y-2 mb-4">
        {cycle.auditors.map((a) => (
          <div key={a.auditor.id} className="flex items-center justify-between text-sm">
            <div>
              <p className="font-medium">{a.auditor.name}</p>
              <p className="text-xs text-slate-400">{a.auditor.email}</p>
            </div>
            {canManage && (
              <button
                onClick={() => removeAuditor(a.auditor.id)}
                disabled={busy}
                className="text-xs text-red-600 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div className="flex gap-2 pt-3 border-t border-slate-100">
          <select
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
          >
            <option value="">Add auditor...</option>
            {available.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button onClick={addAuditor} disabled={busy || !addId} className="btn-primary text-sm px-4 py-2">
            Add
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}

// =======================================================================
// Close cycle — blocked while items remain PENDING, inline confirm
// =======================================================================
function CloseCycleControl({
  cycleId,
  itemSummary,
  onClosed,
}: {
  cycleId: string;
  itemSummary: Record<AuditItemStatus, number>;
  onClosed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = itemSummary.PENDING ?? 0;
  const blocked = pending > 0;

  async function close() {
    setError(null);
    setBusy(true);
    try {
      await api(`/audits/${cycleId}/close`, { method: "POST" });
      onClosed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to close audit cycle");
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <div className="text-right">
        <p className="text-xs text-slate-500 mb-2 max-w-xs">
          Closing locks the cycle. Missing assets become Lost; damaged assets get flagged for maintenance.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={close} disabled={busy} className="btn-danger text-sm px-4 py-2">
            {busy ? "Closing..." : "Confirm Close"}
          </button>
          <button onClick={() => setConfirming(false)} className="btn-secondary text-sm px-4 py-2">
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </div>
    );
  }

  return (
    <div className="text-right">
      <button
        onClick={() => setConfirming(true)}
        disabled={blocked}
        className="btn-primary"
        title={blocked ? `${pending} asset(s) still pending verification` : undefined}
      >
        Close Audit Cycle
      </button>
      {blocked && <p className="text-xs text-slate-400 mt-1">{pending} asset(s) still pending</p>}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
