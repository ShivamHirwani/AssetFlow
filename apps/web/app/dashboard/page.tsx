"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import AppShell from "@/components/AppShell";


type Summary = {
  scope: string;
  kpis: {
    assetsAvailable: number;
    assetsAllocated: number;
    maintenanceToday: number;
    activeBookings: number;
    pendingTransfers: number;
    upcomingReturns: number;
  };
  overdueReturns: number;
  quickActions: { canRegisterAsset: boolean; canBookResource: boolean; canRaiseMaintenanceRequest: boolean };
};

type Returns = { overdue: any[]; upcoming: any[] };

const KPI_LABELS: Record<keyof Summary["kpis"], string> = {
  assetsAvailable: "Assets Available",
  assetsAllocated: "Assets Allocated",
  maintenanceToday: "Maintenance Today",
  activeBookings: "Active Bookings",
  pendingTransfers: "Pending Transfers",
  upcomingReturns: "Upcoming Returns",
};

export default function DashboardPage() {
  const { user, loading } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [returns, setReturns] = useState<Returns | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    Promise.all([api<Summary>("/dashboard/summary"), api<Returns>("/dashboard/returns")])
      .then(([s, r]) => {
        setSummary(s);
        setReturns(r);
      })
      .catch((err) => setError(err.message ?? "Failed to load dashboard"));
  }, [loading, user]);

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading...</div>;

  return (
<AppShell>
    <div className="max-w-6xl mx-auto p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-slate-500">
            {user?.name} · {user?.role}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      {summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            {(Object.keys(KPI_LABELS) as (keyof Summary["kpis"])[]).map((key) => (
              <div key={key} className="bg-white border border-slate-200 rounded-xl p-5">
                <p className="text-sm text-slate-500">{KPI_LABELS[key]}</p>
                <p className="text-2xl font-semibold mt-1">{summary.kpis[key]}</p>
              </div>
            ))}
            <div className="bg-red-50 border border-red-200 rounded-xl p-5">
              <p className="text-sm text-red-600">Overdue Returns</p>
              <p className="text-2xl font-semibold mt-1 text-red-700">{summary.overdueReturns}</p>
            </div>
          </div>

          <div className="flex gap-3 mb-8">
            {summary.quickActions.canRegisterAsset && (
              <button className="text-sm rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-100">
                Register Asset
              </button>
            )}
            {summary.quickActions.canBookResource && (
              <button className="text-sm rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-100">
                Book Resource
              </button>
            )}
            {summary.quickActions.canRaiseMaintenanceRequest && (
              <button className="text-sm rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-100">
                Raise Maintenance Request
              </button>
            )}
          </div>
        </>
      )}

      {returns && (
        <div className="grid md:grid-cols-2 gap-6">
          <ReturnsList title="Overdue Returns" items={returns.overdue} tone="danger" />
          <ReturnsList title="Upcoming Returns" items={returns.upcoming} tone="default" />
        </div>
      )}
    </div>
    </AppShell>
  );
}

function ReturnsList({ title, items, tone }: { title: string; items: any[]; tone: "danger" | "default" }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <h2 className={`text-sm font-medium mb-3 ${tone === "danger" ? "text-red-600" : "text-slate-700"}`}>
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing here.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id} className="text-sm flex justify-between border-b border-slate-100 pb-2 last:border-0">
              <span>
                {a.asset.name} <span className="text-slate-400">({a.asset.assetTag})</span>
              </span>
              <span className="text-slate-500">
                {a.holderEmployee?.name ?? a.holderDepartment?.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
