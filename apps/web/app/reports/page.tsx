"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { StatusBadge } from "@/lib/status-badge";

// =======================================================================
// Shared types
// =======================================================================
type DepartmentOption = {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  head: { id: string; name: string; email: string } | null;
};
type CategoryOption = { id: string; name: string };
type AssetOption = { id: string; assetTag: string; name: string };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("assetflow_token");
}

function toDateInput(v: string) {
  return v; // already yyyy-mm-dd from <input type="date">
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function downloadReportCsv(report: string, query: Record<string, string | number | undefined>) {
  const url = new URL(API_URL + "/reports/export");
  url.searchParams.set("report", report);
  url.searchParams.set("format", "csv");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const token = getToken();
  const res = await fetch(url.toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `${report}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

// =======================================================================
// Main page
// =======================================================================
const TABS = [
  { key: "utilization", label: "Asset Utilization" },
  { key: "maintenance", label: "Maintenance Frequency" },
  { key: "lifecycle", label: "Lifecycle Attention" },
  { key: "departments", label: "Department Summary" },
  { key: "bookings", label: "Booking Heatmap" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function ReportsPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("utilization");
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);

  useEffect(() => {
    api<DepartmentOption[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
  }, []);

  // Department Head only sees departments they head; Admin/Asset Manager see all.
  const departmentOptions =
    user?.role === "DEPARTMENT_HEAD" ? departments.filter((d) => d.head?.id === user.id) : departments;

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-8">
        <h1 className="text-2xl font-semibold mb-1">Reports & Analytics</h1>
        <p className="text-sm text-slate-500 mb-6">Actionable operational insight, exportable whenever you need it.</p>

        <div className="flex gap-2 mb-6 border-b border-slate-200 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${
                tab === t.key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "utilization" && <UtilizationTab departments={departmentOptions} />}
        {tab === "maintenance" && <MaintenanceFrequencyTab departments={departmentOptions} />}
        {tab === "lifecycle" && <LifecycleAttentionTab departments={departmentOptions} />}
        {tab === "departments" && <DepartmentSummaryTab departments={departmentOptions} />}
        {tab === "bookings" && <BookingHeatmapTab departments={departmentOptions} />}
      </div>
    </AppShell>
  );
}

function DepartmentSelect({
  departments,
  value,
  onChange,
  allLabel = "All departments",
}: {
  departments: DepartmentOption[];
  value: string;
  onChange: (v: string) => void;
  allLabel?: string;
}) {
  return (
    <select
      className="rounded-md border border-slate-300 px-3 py-2 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{allLabel}</option>
      {departments.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

function ExportButton({ onExport }: { onExport: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setBusy(true);
    try {
      await onExport();
    } catch {
      setError("Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={handleClick} disabled={busy} className="btn-secondary text-sm px-4 py-2">
        {busy ? "Exporting..." : "Export CSV"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

// =======================================================================
// Tab 1 — Asset Utilization
// =======================================================================
type UtilizationRow = {
  assetId: string;
  assetTag: string;
  name: string;
  category: string;
  status: string;
  daysAllocated: number;
  allocationCount: number;
  bookingCount: number;
  usageScore: number;
};

function UtilizationTab({ departments }: { departments: DepartmentOption[] }) {
  const [departmentId, setDepartmentId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(10);
  const [categories, setCategories] = useState<CategoryOption[]>([]);

  const [data, setData] = useState<{ from: string; to: string; mostUsed: UtilizationRow[]; idle: UtilizationRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CategoryOption[]>("/asset-categories").then(setCategories).catch(() => setCategories([]));
  }, []);

  function load() {
    setLoading(true);
    setError(null);
    api<{ from: string; to: string; mostUsed: UtilizationRow[]; idle: UtilizationRow[] }>("/reports/asset-utilization", {
      query: { departmentId: departmentId || undefined, categoryId: categoryId || undefined, from: from || undefined, to: to || undefined, limit },
    })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [departmentId, categoryId, from, to, limit]);

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <DepartmentSelect departments={departments} value={departmentId} onChange={setDepartmentId} />
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={from} onChange={(e) => setFrom(toDateInput(e.target.value))} />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={to} onChange={(e) => setTo(toDateInput(e.target.value))} />
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {[5, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                Top {n}
              </option>
            ))}
          </select>
        </div>
        <ExportButton onExport={() => downloadReportCsv("asset-utilization", { departmentId, categoryId, from, to, limit })} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading || !data ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : (
        <div className="space-y-6">
          <p className="text-xs text-slate-400">
            {formatDate(data.from)} – {formatDate(data.to)}
          </p>

          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Most Used</p>
            {data.mostUsed.length === 0 ? (
              <div className="card p-6 text-center text-sm text-slate-500">No usage data in this range.</div>
            ) : (
              <div className="card overflow-hidden">
                <table>
                  <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    <tr>
                      <th className="px-4 py-3">#</th>
                      <th className="px-4 py-3">Asset</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Days Allocated</th>
                      <th className="px-4 py-3">Allocations</th>
                      <th className="px-4 py-3">Bookings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {data.mostUsed.map((r, i) => (
                      <tr key={r.assetId}>
                        <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium">{r.name}</p>
                          <p className="text-xs text-slate-400 font-mono">{r.assetTag}</p>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{r.category}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-4 py-3 text-slate-600">{r.daysAllocated}</td>
                        <td className="px-4 py-3 text-slate-600">{r.allocationCount}</td>
                        <td className="px-4 py-3 text-slate-600">{r.bookingCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
              Idle Assets <span className="text-slate-300">({data.idle.length})</span>
            </p>
            {data.idle.length === 0 ? (
              <div className="card p-6 text-center text-sm text-slate-500">Nothing idle in this range.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data.idle.map((r) => (
                  <span key={r.assetId} className="card px-3 py-1.5 text-xs text-slate-600">
                    {r.name} <span className="text-slate-400 font-mono">({r.assetTag})</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Tab 2 — Maintenance Frequency
// =======================================================================
type FrequencyGroup = { key: string; label: string; total: number; byStatus: Record<string, number> };

function MaintenanceFrequencyTab({ departments }: { departments: DepartmentOption[] }) {
  const [departmentId, setDepartmentId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [groupBy, setGroupBy] = useState<"asset" | "category">("category");

  const [data, setData] = useState<{ from: string; to: string; groups: FrequencyGroup[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api<{ from: string; to: string; groups: FrequencyGroup[] }>("/reports/maintenance-frequency", {
      query: { departmentId: departmentId || undefined, from: from || undefined, to: to || undefined, groupBy },
    })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [departmentId, from, to, groupBy]);

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <DepartmentSelect departments={departments} value={departmentId} onChange={setDepartmentId} />
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          <div className="flex gap-2 text-xs">
            {(["category", "asset"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`px-3 py-1.5 rounded-full font-medium ${
                  groupBy === g ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                }`}
              >
                By {g === "category" ? "Category" : "Asset"}
              </button>
            ))}
          </div>
        </div>
        <ExportButton onExport={() => downloadReportCsv("maintenance-frequency", { departmentId, from, to, groupBy })} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading || !data ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : data.groups.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">No maintenance requests in this range.</div>
      ) : (
        <div className="card overflow-hidden">
          <table>
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">{groupBy === "category" ? "Category" : "Asset"}</th>
                <th className="px-4 py-3">Total Requests</th>
                <th className="px-4 py-3">By Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {data.groups.map((g) => (
                <tr key={g.key}>
                  <td className="px-4 py-3 font-medium">{g.label}</td>
                  <td className="px-4 py-3 text-slate-600">{g.total}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(g.byStatus).map(([status, count]) => (
                        <span key={status} className="badge badge-slate">
                          {status.replace(/_/g, " ")}: {count}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Tab 3 — Lifecycle Attention
// =======================================================================
type RetirementRow = { assetId: string; assetTag: string; name: string; acquisitionDate: string; ageYears: number };
type MaintenanceDueRow = { assetId: string; assetTag: string; name: string; lastServiced: string; daysSinceServiced: number };

function LifecycleAttentionTab({ departments }: { departments: DepartmentOption[] }) {
  const [departmentId, setDepartmentId] = useState("");
  const [lifespanYears, setLifespanYears] = useState(5);
  const [maintenanceDueDays, setMaintenanceDueDays] = useState(180);

  const [data, setData] = useState<{
    overdueForRetirement: RetirementRow[];
    nearingRetirement: RetirementRow[];
    dueForMaintenance: MaintenanceDueRow[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api<{
      overdueForRetirement: RetirementRow[];
      nearingRetirement: RetirementRow[];
      dueForMaintenance: MaintenanceDueRow[];
    }>("/reports/lifecycle-attention", {
      query: { departmentId: departmentId || undefined, lifespanYears, maintenanceDueDays },
    })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [departmentId, lifespanYears, maintenanceDueDays]);

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <DepartmentSelect departments={departments} value={departmentId} onChange={setDepartmentId} />
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Expected lifespan
            <input
              type="number"
              min={1}
              max={50}
              className="w-16 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              value={lifespanYears}
              onChange={(e) => setLifespanYears(Number(e.target.value))}
            />
            years
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Maintenance due after
            <input
              type="number"
              min={1}
              max={3650}
              className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              value={maintenanceDueDays}
              onChange={(e) => setMaintenanceDueDays(Number(e.target.value))}
            />
            days
          </label>
        </div>
        <ExportButton onExport={() => downloadReportCsv("lifecycle-attention", { departmentId, lifespanYears, maintenanceDueDays })} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading || !data ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <LifecycleColumn title="Overdue for Retirement" tone="red">
            {data.overdueForRetirement.map((r) => (
              <div key={r.assetId} className="text-sm">
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-slate-400 font-mono">{r.assetTag} · {r.ageYears}y old</p>
              </div>
            ))}
          </LifecycleColumn>
          <LifecycleColumn title="Nearing Retirement" tone="amber">
            {data.nearingRetirement.map((r) => (
              <div key={r.assetId} className="text-sm">
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-slate-400 font-mono">{r.assetTag} · {r.ageYears}y old</p>
              </div>
            ))}
          </LifecycleColumn>
          <LifecycleColumn title="Due for Maintenance" tone="orange">
            {data.dueForMaintenance.map((r) => (
              <div key={r.assetId} className="text-sm">
                <p className="font-medium">{r.name}</p>
                <p className="text-xs text-slate-400 font-mono">{r.assetTag} · {r.daysSinceServiced}d since serviced</p>
              </div>
            ))}
          </LifecycleColumn>
        </div>
      )}
    </div>
  );
}

function LifecycleColumn({ title, tone, children }: { title: string; tone: "red" | "amber" | "orange"; children: React.ReactNode }) {
  const dot = { red: "bg-red-500", amber: "bg-amber-500", orange: "bg-orange-500" }[tone];
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some((c: any) => c);

  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        {title}
      </p>
      <div className="space-y-3">
        {hasItems ? children : <p className="text-xs text-slate-300 italic">Nothing here</p>}
      </div>
    </div>
  );
}

// =======================================================================
// Tab 4 — Department Summary
// =======================================================================
type DeptSummaryRow = {
  departmentId: string;
  departmentName: string;
  status: string;
  assetsOwned: number;
  activeAllocationsAsHolder: number;
  activeAllocationsToEmployees: number;
  totalAllocationsHistorical: number;
};

function DepartmentSummaryTab({ departments }: { departments: DepartmentOption[] }) {
  const [departmentId, setDepartmentId] = useState("");
  const [data, setData] = useState<{ departments: DeptSummaryRow[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api<{ departments: DeptSummaryRow[] }>("/reports/department-summary", {
      query: { departmentId: departmentId || undefined },
    })
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [departmentId]);

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center justify-between">
        <DepartmentSelect departments={departments} value={departmentId} onChange={setDepartmentId} />
        <ExportButton onExport={() => downloadReportCsv("department-summary", { departmentId })} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading || !data ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : data.departments.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">No departments in scope.</div>
      ) : (
        <div className="card overflow-hidden">
          <table>
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Assets Owned</th>
                <th className="px-4 py-3">Active (as holder)</th>
                <th className="px-4 py-3">Active (to employees)</th>
                <th className="px-4 py-3">Total Historical</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {data.departments.map((d) => (
                <tr key={d.departmentId}>
                  <td className="px-4 py-3 font-medium">{d.departmentName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{d.assetsOwned}</td>
                  <td className="px-4 py-3 text-slate-600">{d.activeAllocationsAsHolder}</td>
                  <td className="px-4 py-3 text-slate-600">{d.activeAllocationsToEmployees}</td>
                  <td className="px-4 py-3 text-slate-600">{d.totalAllocationsHistorical}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =======================================================================
// Tab 5 — Booking Heatmap
// =======================================================================
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function BookingHeatmapTab({ departments }: { departments: DepartmentOption[] }) {
  const [departmentId, setDepartmentId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [assets, setAssets] = useState<AssetOption[]>([]);

  const [data, setData] = useState<{ from: string; to: string; totalBookings: number; grid: number[][]; peak: { dayOfWeek: number; hour: number; count: number } } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ assets: AssetOption[] }>("/assets", { query: { pageSize: 100, isBookable: "true" } })
      .then((res) => setAssets(res.assets))
      .catch(() => setAssets([]));
  }, []);

  function load() {
    setLoading(true);
    setError(null);
    api<{ from: string; to: string; totalBookings: number; grid: number[][]; peak: { dayOfWeek: number; hour: number; count: number } }>(
      "/reports/booking-heatmap",
      { query: { departmentId: departmentId || undefined, assetId: assetId || undefined, from: from || undefined, to: to || undefined } }
    )
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [departmentId, assetId, from, to]);

  const maxCount = data ? Math.max(1, ...data.grid.flat()) : 1;

  return (
    <div>
      <div className="card p-4 mb-5 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-3 items-center">
          <DepartmentSelect departments={departments} value={departmentId} onChange={setDepartmentId} />
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          >
            <option value="">All bookable assets</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.assetTag} — {a.name}
              </option>
            ))}
          </select>
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" className="rounded-md border border-slate-300 px-3 py-2 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <ExportButton onExport={() => downloadReportCsv("booking-heatmap", { departmentId, assetId, from, to })} />
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {loading || !data ? (
        <p className="text-sm text-slate-400">Loading...</p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-6 text-sm text-slate-600">
            <p>
              Total bookings: <span className="font-medium text-slate-900">{data.totalBookings}</span>
            </p>
            {data.totalBookings > 0 && (
              <p>
                Peak: <span className="font-medium text-slate-900">{DAY_LABELS[data.peak.dayOfWeek]} {data.peak.hour}:00</span>{" "}
                ({data.peak.count} booking{data.peak.count === 1 ? "" : "s"})
              </p>
            )}
          </div>

          <div className="card p-4 overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="pr-2 text-left text-slate-400 font-medium">Day \ Hour</th>
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} className="px-1 text-center text-slate-400 font-normal w-6">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAY_LABELS.map((label, d) => (
                  <tr key={label}>
                    <td className="pr-2 text-slate-500 font-medium whitespace-nowrap">{label}</td>
                    {data.grid[d].map((count, h) => (
                      <td key={h} className="p-0.5">
                        <div
                          className="w-6 h-6 rounded-sm"
                          style={{
                            backgroundColor: count === 0 ? "var(--color-slate-100, #f1f5f9)" : `rgba(15, 23, 42, ${0.15 + 0.85 * (count / maxCount)})`,
                          }}
                          title={`${label} ${h}:00 — ${count} booking${count === 1 ? "" : "s"}`}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
