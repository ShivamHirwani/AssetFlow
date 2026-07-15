"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { api, ApiError } from "@/lib/api";
import AppShell from "@/components/AppShell";


type Asset = { id: string; assetTag: string; name: string; status: string };
type User = { id: string; name: string; email: string };
type Department = { id: string; name: string };
type Holder = { id: string; name: string; email?: string };

type Allocation = {
  id: string;
  status: string;
  holderType: "EMPLOYEE" | "DEPARTMENT";
  expectedReturnDate: string | null;
  asset: Asset;
  holderEmployee: Holder | null;
  holderDepartment: Holder | null;
};

type TransferRequest = {
  id: string;
  status: string;
  reason: string | null;
  asset: Asset;
  requestedBy: { id: string; name: string };
  toHolderType: string;
  toHolderEmployeeId: string | null;
  toHolderDepartmentId: string | null;
};

export default function AllocationsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"allocate" | "active" | "transfers">("allocate");

  const canAllocate = user && ["ADMIN", "ASSET_MANAGER"].includes(user.role);

  return (
<AppShell>
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-1">Asset Allocation & Transfer</h1>
      <p className="text-sm text-slate-500 mb-6">Allocate assets, handle conflicts, and manage transfers.</p>

      <div className="flex gap-2 mb-6 border-b border-slate-200">
        {canAllocate && (
          <TabButton active={tab === "allocate"} onClick={() => setTab("allocate")}>
            Allocate
          </TabButton>
        )}
        <TabButton active={tab === "active"} onClick={() => setTab("active")}>
          Active Allocations
        </TabButton>
        <TabButton active={tab === "transfers"} onClick={() => setTab("transfers")}>
          Transfer Requests
        </TabButton>
      </div>

      {tab === "allocate" && canAllocate && <AllocateForm />}
      {tab === "active" && <ActiveAllocations />}
      {tab === "transfers" && <TransferRequests />}
    </div>
    </AppShell>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

// ---------------------------------------------------------------------
// Allocate — the conflict-handling flow. Attempts POST /allocations;
// on 409 (already allocated), shows the current holder + a button that
// raises a transfer request instead, matching the spec's example.
// ---------------------------------------------------------------------
function AllocateForm() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);

  const [assetId, setAssetId] = useState("");
  const [holderType, setHolderType] = useState<"EMPLOYEE" | "DEPARTMENT">("EMPLOYEE");
  const [holderId, setHolderId] = useState("");
  const [expectedReturnDate, setExpectedReturnDate] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentHolder: Holder; assetId: string } | null>(null);

  useEffect(() => {
    api<{ assets: Asset[] }>("/assets", { query: { status: "AVAILABLE", pageSize: 100 } })
      .then((r) => setAssets(r.assets ?? (r as any)))
      .catch(() => setAssets([]));
    api<User[]>("/users").then(setUsers).catch(() => setUsers([]));
    api<Department[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
  }, []);

  async function handleAllocate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setConflict(null);
    setBusy(true);
    try {
      await api("/allocations", {
        method: "POST",
        body: {
          assetId,
          holderType,
          holderEmployeeId: holderType === "EMPLOYEE" ? holderId : undefined,
          holderDepartmentId: holderType === "DEPARTMENT" ? holderId : undefined,
          expectedReturnDate: expectedReturnDate || undefined,
        },
      });
      setSuccess("Asset allocated successfully.");
      setAssetId("");
      setHolderId("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = (err as any).body ?? null;
        // ApiError only carries message by default — refetch to get currentHolder detail.
        try {
          const res = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/allocations`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
          );
        } catch {}
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestTransfer() {
    if (!conflict) return;
    setBusy(true);
    setError(null);
    try {
      await api("/transfer-requests", {
        method: "POST",
        body: {
          assetId: conflict.assetId,
          toHolderType: holderType,
          toHolderEmployeeId: holderType === "EMPLOYEE" ? holderId : undefined,
          toHolderDepartmentId: holderType === "DEPARTMENT" ? holderId : undefined,
          reason: "Requested via Allocation screen after conflict",
        },
      });
      setSuccess("Transfer request raised — the current holder and approvers have been notified.");
      setConflict(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-lg">
      <form onSubmit={handleAllocate} className="space-y-4">
        <div>
          <label className="text-sm font-medium block mb-1">Asset</label>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            required
          >
            <option value="">Select an asset...</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.assetTag} — {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm font-medium block mb-1">Allocate to</label>
          <div className="flex gap-4 mb-2">
            <label className="text-sm flex items-center gap-1">
              <input
                type="radio"
                checked={holderType === "EMPLOYEE"}
                onChange={() => {
                  setHolderType("EMPLOYEE");
                  setHolderId("");
                }}
              />
              Employee
            </label>
            <label className="text-sm flex items-center gap-1">
              <input
                type="radio"
                checked={holderType === "DEPARTMENT"}
                onChange={() => {
                  setHolderType("DEPARTMENT");
                  setHolderId("");
                }}
              />
              Department
            </label>
          </div>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={holderId}
            onChange={(e) => setHolderId(e.target.value)}
            required
          >
            <option value="">Select {holderType === "EMPLOYEE" ? "an employee" : "a department"}...</option>
            {(holderType === "EMPLOYEE" ? users : departments).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm font-medium block mb-1">Expected Return Date (optional)</label>
          <input
            type="date"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={expectedReturnDate}
            onChange={(e) => setExpectedReturnDate(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm text-green-600">{success}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-slate-900 text-white text-sm font-medium py-2 disabled:opacity-50"
        >
          {busy ? "Allocating..." : "Allocate Asset"}
        </button>
      </form>

      {conflict && (
        <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 p-4">
          <p className="text-sm text-amber-800">
            This asset is currently held by <strong>{conflict.currentHolder.name}</strong>.
          </p>
          <button
            onClick={handleRequestTransfer}
            disabled={busy}
            className="mt-3 text-sm rounded-md bg-amber-600 text-white px-4 py-2 disabled:opacity-50"
          >
            Request Transfer Instead
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Active allocations — list + return action.
// ---------------------------------------------------------------------
function ActiveAllocations() {
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api<{ allocations: Allocation[] }>("/allocations", { query: { status: "ACTIVE", pageSize: 100 } })
      .then((r) => setAllocations(r.allocations))
      .catch((err) => setError(err.message ?? "Failed to load allocations"));
  }

  useEffect(load, []);

  async function handleReturn(id: string) {
    setBusyId(id);
    try {
      await api(`/allocations/${id}/return`, { method: "POST", body: {} });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to return asset");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6">
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {allocations.length === 0 ? (
        <p className="text-sm text-slate-400">No active allocations.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-100">
              <th className="pb-2">Asset</th>
              <th className="pb-2">Holder</th>
              <th className="pb-2">Expected Return</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((a) => (
              <tr key={a.id} className="border-b border-slate-50 last:border-0">
                <td className="py-2">
                  {a.asset.name} <span className="text-slate-400">({a.asset.assetTag})</span>
                </td>
                <td className="py-2">{a.holderEmployee?.name ?? a.holderDepartment?.name}</td>
                <td className="py-2">
                  {a.expectedReturnDate ? new Date(a.expectedReturnDate).toLocaleDateString() : "—"}
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => handleReturn(a.id)}
                    disabled={busyId === a.id}
                    className="text-xs rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {busyId === a.id ? "..." : "Mark Returned"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Transfer requests — list + approve/reject for authorized roles.
// ---------------------------------------------------------------------
function TransferRequests() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<TransferRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canDecide = user && ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"].includes(user.role);

  function load() {
    api<{ transferRequests: TransferRequest[] }>("/transfer-requests", { query: { pageSize: 100 } })
      .then((r) => setRequests(r.transferRequests))
      .catch((err) => setError(err.message ?? "Failed to load transfer requests"));
  }

  useEffect(load, []);

  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    setBusyId(id);
    try {
      await api(`/transfer-requests/${id}/decision`, { method: "POST", body: { decision } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to record decision");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6">
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {requests.length === 0 ? (
        <p className="text-sm text-slate-400">No transfer requests.</p>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => (
            <li key={r.id} className="border border-slate-100 rounded-lg p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">
                  {r.asset.name} <span className="text-slate-400">({r.asset.assetTag})</span>
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Requested by {r.requestedBy.name} · Status: {r.status}
                  {r.reason && ` · "${r.reason}"`}
                </p>
              </div>
              {canDecide && r.status === "REQUESTED" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(r.id, "APPROVE")}
                    disabled={busyId === r.id}
                    className="text-xs rounded-md bg-green-600 text-white px-3 py-1 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(r.id, "REJECT")}
                    disabled={busyId === r.id}
                    className="text-xs rounded-md bg-red-600 text-white px-3 py-1 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
