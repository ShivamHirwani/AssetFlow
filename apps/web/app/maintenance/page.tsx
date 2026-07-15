"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// =======================================================================
// Types
// =======================================================================
const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
type Priority = (typeof PRIORITY_VALUES)[number];

type MaintenanceStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "TECHNICIAN_ASSIGNED"
  | "IN_PROGRESS"
  | "RESOLVED";

// The board's success path, in order. REJECTED is rendered as its own
// column off to the side since it's a terminal branch off PENDING, not a
// step on the main flow.
const BOARD_COLUMNS: { status: MaintenanceStatus; label: string }[] = [
  { status: "PENDING", label: "Pending" },
  { status: "APPROVED", label: "Approved" },
  { status: "TECHNICIAN_ASSIGNED", label: "Technician Assigned" },
  { status: "IN_PROGRESS", label: "In Progress" },
  { status: "RESOLVED", label: "Resolved" },
  { status: "REJECTED", label: "Rejected" },
];

type AssetOption = { id: string; assetTag: string; name: string; status: string };
type EmployeeOption = { id: string; name: string; email: string; role: string };

type MaintenanceRequest = {
  id: string;
  issueDescription: string;
  priority: Priority;
  status: MaintenanceStatus;
  decisionNotes?: string | null;
  resolutionNotes?: string | null;
  technicianName?: string | null;
  createdAt: string;
  asset: { id: string; assetTag: string; name: string; status: string };
  raisedBy: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string } | null;
  technician: { id: string; name: string; email: string } | null;
  attachments: { id: string; url: string; fileName: string | null }[];
};

const PRIORITY_STYLES: Record<Priority, string> = {
  LOW: "bg-slate-100 text-slate-500",
  MEDIUM: "bg-blue-50 text-blue-700",
  HIGH: "bg-amber-50 text-amber-700",
  CRITICAL: "bg-red-50 text-red-700",
};

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority]}`}>
      {priority}
    </span>
  );
}

const NOT_SERVICEABLE = ["LOST", "RETIRED", "DISPOSED"];

// =======================================================================
// Main page
// =======================================================================
export default function MaintenancePage() {
  const { user } = useAuth();
  const isManager = ["ADMIN", "ASSET_MANAGER"].includes(user?.role ?? "");

  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [priorityFilter, setPriorityFilter] = useState<Priority | "">("");
  const [assetFilter, setAssetFilter] = useState("");
  const [mineOnly, setMineOnly] = useState(false);

  const [showForm, setShowForm] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    api<{ maintenanceRequests: MaintenanceRequest[] }>("/maintenance-requests", {
      query: {
        priority: priorityFilter || undefined,
        assetId: assetFilter || undefined,
        raisedById: mineOnly ? user?.id : undefined,
        pageSize: 100,
      },
    })
      .then((res) => setRequests(res.maintenanceRequests))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load maintenance requests"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [priorityFilter, assetFilter, mineOnly]);

  useEffect(() => {
    api<{ assets: AssetOption[] }>("/assets", { query: { pageSize: 100 } })
      .then((res) => setAssets(res.assets.filter((a) => !NOT_SERVICEABLE.includes(a.status))))
      .catch(() => setAssets([]));
    if (isManager) {
      api<EmployeeOption[]>("/users").then(setEmployees).catch(() => setEmployees([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isManager]);

  const columns = BOARD_COLUMNS.map((col) => ({
    ...col,
    items: requests.filter((r) => r.status === col.status),
  }));

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto p-8">
        <div className="flex justify-between items-start mb-1">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Maintenance</h1>
            <p className="text-sm text-slate-500">Route repairs through approval before work starts.</p>
          </div>
          <button onClick={() => setShowForm(!showForm)} className="btn-primary">
            {showForm ? "Cancel" : "+ Raise Maintenance Request"}
          </button>
        </div>

        {showForm && (
          <RaiseRequestForm
            assets={assets}
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        )}

        <div className="card p-4 mt-6 mb-5 flex flex-wrap gap-3 items-center">
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={assetFilter}
            onChange={(e) => setAssetFilter(e.target.value)}
          >
            <option value="">All assets</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.assetTag} — {a.name}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as Priority | "")}
          >
            <option value="">All priorities</option>
            {PRIORITY_VALUES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            My requests only
          </label>
        </div>

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {columns.map((col) => (
              <div key={col.status} className="w-72 shrink-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
                  {col.label} <span className="text-slate-300">({col.items.length})</span>
                </p>
                <div className="space-y-3">
                  {col.items.length === 0 && (
                    <p className="text-xs text-slate-300 italic">Nothing here</p>
                  )}
                  {col.items.map((r) => (
                    <RequestCard
                      key={r.id}
                      request={r}
                      isManager={isManager}
                      currentUserId={user?.id}
                      employees={employees}
                      onChanged={load}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// =======================================================================
// Raise request form
// =======================================================================
function RaiseRequestForm({
  assets,
  onCreated,
}: {
  assets: AssetOption[];
  onCreated: () => void;
}) {
  const [assetId, setAssetId] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("MEDIUM");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      await api("/maintenance-requests", {
        method: "POST",
        body: {
          assetId,
          issueDescription,
          priority,
          attachments: attachmentUrl ? [{ url: attachmentUrl }] : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to raise maintenance request");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 mt-6 space-y-3 max-w-xl">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">New Maintenance Request</p>

      <select
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        value={assetId}
        onChange={(e) => setAssetId(e.target.value)}
        required
      >
        <option value="">Select asset</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.assetTag} — {a.name}
          </option>
        ))}
      </select>

      <textarea
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="Describe the issue"
        rows={3}
        value={issueDescription}
        onChange={(e) => setIssueDescription(e.target.value)}
        required
      />

      <select
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
      >
        {PRIORITY_VALUES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>

      <input
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="Photo/document URL (optional)"
        value={attachmentUrl}
        onChange={(e) => setAttachmentUrl(e.target.value)}
      />

      {formError && <p className="text-sm text-red-600">{formError}</p>}
      <button type="submit" disabled={saving} className="btn-primary">
        {saving ? "Submitting..." : "Raise Request"}
      </button>
    </form>
  );
}

// =======================================================================
// Card — renders the action relevant to its current status
// =======================================================================
function RequestCard({
  request,
  isManager,
  currentUserId,
  employees,
  onChanged,
}: {
  request: MaintenanceRequest;
  isManager: boolean;
  currentUserId: string | undefined;
  employees: EmployeeOption[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isAssignedTechnician = request.technician?.id === currentUserId;
  const canWorkOn = isManager || isAssignedTechnician;

  async function post(path: string, body?: any) {
    setError(null);
    setBusy(true);
    try {
      await api(`/maintenance-requests/${request.id}${path}`, { method: "POST", body });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-3 text-sm">
      <div className="flex justify-between items-start mb-1">
        <p className="font-medium">{request.asset.name}</p>
        <PriorityBadge priority={request.priority} />
      </div>
      <p className="text-xs text-slate-400 font-mono mb-2">{request.asset.assetTag}</p>
      <p className={`text-slate-600 ${expanded ? "" : "line-clamp-2"}`}>{request.issueDescription}</p>
      {request.issueDescription.length > 80 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-slate-400 hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <p className="text-xs text-slate-400 mt-2">Raised by {request.raisedBy.name}</p>

      {request.technician && (
        <p className="text-xs text-slate-400">Technician: {request.technician.name}</p>
      )}
      {!request.technician && request.technicianName && (
        <p className="text-xs text-slate-400">Technician: {request.technicianName} (external)</p>
      )}
      {request.decisionNotes && (
        <p className="text-xs text-slate-400 mt-1 italic">"{request.decisionNotes}"</p>
      )}
      {request.resolutionNotes && (
        <p className="text-xs text-slate-400 mt-1 italic">"{request.resolutionNotes}"</p>
      )}

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      <div className="mt-3">
        {request.status === "PENDING" && isManager && (
          <DecisionControls busy={busy} onApprove={() => post("/decision", { decision: "APPROVE" })} onReject={(notes) => post("/decision", { decision: "REJECT", decisionNotes: notes })} />
        )}

        {request.status === "APPROVED" && isManager && (
          <AssignTechnicianControls busy={busy} employees={employees} onAssign={(payload) => post("/assign-technician", payload)} />
        )}

        {request.status === "TECHNICIAN_ASSIGNED" && canWorkOn && (
          <button onClick={() => post("/start")} disabled={busy} className="btn-secondary text-xs px-3 py-1.5 w-full">
            {busy ? "..." : "Start Work"}
          </button>
        )}

        {request.status === "IN_PROGRESS" && canWorkOn && (
          <ResolveControls busy={busy} onResolve={(notes) => post("/resolve", { resolutionNotes: notes })} />
        )}
      </div>
    </div>
  );
}

function DecisionControls({
  busy,
  onApprove,
  onReject,
}: {
  busy: boolean;
  onApprove: () => void;
  onReject: (notes?: string) => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [notes, setNotes] = useState("");

  if (showReject) {
    return (
      <div className="space-y-2">
        <input
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          placeholder="Reason (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            onClick={() => onReject(notes || undefined)}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white flex-1"
          >
            Confirm Reject
          </button>
          <button onClick={() => setShowReject(false)} className="btn-secondary text-xs px-3 py-1.5">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <button onClick={onApprove} disabled={busy} className="btn-primary text-xs px-3 py-1.5 flex-1">
        Approve
      </button>
      <button onClick={() => setShowReject(true)} disabled={busy} className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-600 flex-1">
        Reject
      </button>
    </div>
  );
}

function AssignTechnicianControls({
  busy,
  employees,
  onAssign,
}: {
  busy: boolean;
  employees: EmployeeOption[];
  onAssign: (payload: { technicianId?: string; technicianName?: string }) => void;
}) {
  const [mode, setMode] = useState<"system" | "external">("system");
  const [technicianId, setTechnicianId] = useState("");
  const [technicianName, setTechnicianName] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "system" && technicianId) onAssign({ technicianId });
    if (mode === "external" && technicianName) onAssign({ technicianName });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setMode("system")}
          className={`flex-1 py-1 rounded-md ${mode === "system" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}
        >
          System user
        </button>
        <button
          type="button"
          onClick={() => setMode("external")}
          className={`flex-1 py-1 rounded-md ${mode === "external" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}
        >
          External
        </button>
      </div>
      {mode === "system" ? (
        <select
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          value={technicianId}
          onChange={(e) => setTechnicianId(e.target.value)}
        >
          <option value="">Select employee</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          placeholder="Technician name"
          value={technicianName}
          onChange={(e) => setTechnicianName(e.target.value)}
        />
      )}
      <button
        type="submit"
        disabled={busy || (mode === "system" ? !technicianId : !technicianName)}
        className="btn-primary text-xs px-3 py-1.5 w-full"
      >
        {busy ? "..." : "Assign"}
      </button>
    </form>
  );
}

function ResolveControls({
  busy,
  onResolve,
}: {
  busy: boolean;
  onResolve: (notes?: string) => void;
}) {
  const [notes, setNotes] = useState("");
  return (
    <div className="space-y-2">
      <input
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        placeholder="Resolution notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <button
        onClick={() => onResolve(notes || undefined)}
        disabled={busy}
        className="btn-primary text-xs px-3 py-1.5 w-full"
      >
        {busy ? "..." : "Mark Resolved"}
      </button>
    </div>
  );
}
