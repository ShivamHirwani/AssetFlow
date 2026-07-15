"use client";

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { StatusBadge } from "@/lib/status-badge";

// =======================================================================
// Types
// =======================================================================
const ASSET_STATUS_VALUES = [
  "AVAILABLE",
  "ALLOCATED",
  "RESERVED",
  "UNDER_MAINTENANCE",
  "LOST",
  "RETIRED",
  "DISPOSED",
] as const;
type AssetStatus = (typeof ASSET_STATUS_VALUES)[number];

const CONDITION_VALUES = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"] as const;
type Condition = (typeof CONDITION_VALUES)[number];

// Mirrors ALLOWED_STATUS_TRANSITIONS on the backend, just so the "Change
// Status" dropdown only offers moves that won't 400. The backend remains
// the source of truth — if these ever drift apart the API call still
// fails safely and shows the server's error message.
const ALLOWED_STATUS_TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  AVAILABLE: ["UNDER_MAINTENANCE", "LOST", "RETIRED"],
  ALLOCATED: ["LOST"],
  RESERVED: ["AVAILABLE"],
  UNDER_MAINTENANCE: ["AVAILABLE", "LOST", "RETIRED"],
  LOST: ["AVAILABLE"],
  RETIRED: ["DISPOSED", "AVAILABLE"],
  DISPOSED: [],
};

type CustomFieldDef = { key: string; label: string; type: "text" | "number" | "date" | "boolean" };

type CategorySummary = { id: string; name: string; customFields: CustomFieldDef[] | null };
type DepartmentSummary = { id: string; name: string };

type AssetListItem = {
  id: string;
  assetTag: string;
  name: string;
  status: AssetStatus;
  condition: Condition;
  serialNumber: string | null;
  qrCode: string | null;
  location: string | null;
  isBookable: boolean;
  category: { id: string; name: string };
  department: { id: string; name: string } | null;
  registeredBy: { id: string; name: string };
  createdAt: string;
};

type Attachment = { id: string; url: string; fileName: string | null; mimeType: string | null; createdAt: string };

type AssetDetail = AssetListItem & {
  acquisitionDate: string | null;
  acquisitionCost: number | null;
  customFieldValues: Record<string, any> | null;
  category: { id: string; name: string; customFields: CustomFieldDef[] | null };
  allocations: {
    holderEmployee: { id: string; name: string; email: string } | null;
    holderDepartment: { id: string; name: string } | null;
  }[];
  attachments: Attachment[];
};

// Maintenance-history field names aren't confirmed against maintenance/routes.ts
// yet — rendered defensively with optional chaining so this won't break once
// that module is wired in, but field labels here are a best guess from the spec.
type MaintenanceHistoryEntry = {
  id: string;
  status?: string;
  priority?: string;
  issueDescription?: string;
  description?: string;
  createdAt?: string;
  raisedBy?: { id: string; name: string } | null;
  technician?: { id: string; name: string } | null;
};

type AllocationHistoryEntry = {
  id: string;
  status: "ACTIVE" | "RETURNED" | "CANCELLED";
  allocatedAt: string;
  expectedReturnDate: string | null;
  actualReturnDate: string | null;
  checkInCondition: string | null;
  holderEmployee: { id: string; name: string; email: string } | null;
  holderDepartment: { id: string; name: string } | null;
  allocatedBy: { id: string; name: string };
  returnedBy: { id: string; name: string } | null;
};

const PAGE_SIZE = 20;

// =======================================================================
// Main page
// =======================================================================
export default function AssetsPage() {
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState<AssetStatus | "">("");
  const [bookableOnly, setBookableOnly] = useState(false);

  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [departments, setDepartments] = useState<DepartmentSummary[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  // Debounce free-text search so we're not hitting the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      setSearch(searchInput);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    api<CategorySummary[]>("/asset-categories").then(setCategories).catch(() => setCategories([]));
    api<DepartmentSummary[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
  }, []);

  function loadAssets() {
    setLoading(true);
    setError(null);
    api<{ total: number; page: number; pageSize: number; assets: AssetListItem[] }>("/assets", {
      query: {
        search: search || undefined,
        categoryId: categoryId || undefined,
        departmentId: departmentId || undefined,
        status: status || undefined,
        isBookable: bookableOnly ? "true" : undefined,
        page,
        pageSize: PAGE_SIZE,
      },
    })
      .then((res) => {
        setAssets(res.assets);
        setTotal(res.total);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load assets"))
      .finally(() => setLoading(false));
  }

  useEffect(loadAssets, [search, categoryId, departmentId, status, bookableOnly, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-8">
        <div className="flex justify-between items-start mb-1">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Assets</h1>
            <p className="text-sm text-slate-500">Register assets and search/track them centrally.</p>
          </div>
          <button
            onClick={() => {
              setShowForm(!showForm);
              setSuccessMessage(null);
            }}
            className="btn-primary"
          >
            {showForm ? "Cancel" : "+ Register Asset"}
          </button>
        </div>

        {successMessage && (
          <p className="text-sm text-emerald-600 bg-emerald-50 rounded-md px-3 py-2 mt-4">
            {successMessage}
          </p>
        )}

        {showForm && (
          <RegisterAssetForm
            categories={categories}
            departments={departments}
            onCreated={(asset) => {
              setShowForm(false);
              setSuccessMessage(`Asset ${asset.assetTag} — ${asset.name} registered.`);
              setPage(1);
              loadAssets();
            }}
          />
        )}

        {/* Filters */}
        <div className="card p-4 mt-6 mb-4 flex flex-wrap gap-3 items-center">
          <input
            className="flex-1 min-w-[220px] rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Search by tag, serial number, QR code, or name"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={departmentId}
            onChange={(e) => {
              setDepartmentId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as AssetStatus | "");
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {ASSET_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={bookableOnly}
              onChange={(e) => {
                setBookableOnly(e.target.checked);
                setPage(1);
              }}
            />
            Bookable only
          </label>
        </div>

        {/* Directory table */}
        <div className="card p-5">
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          {loading ? (
            <p className="text-sm text-slate-400">Loading...</p>
          ) : assets.length === 0 ? (
            <p className="text-sm text-slate-400">No assets match these filters.</p>
          ) : (
            <>
              <table>
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100 text-sm">
                    <th className="pb-2">Asset Tag</th>
                    <th className="pb-2">Name</th>
                    <th className="pb-2">Category</th>
                    <th className="pb-2">Department</th>
                    <th className="pb-2">Location</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2">Bookable</th>
                    <th className="pb-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr
                      key={a.id}
                      className="border-b border-slate-50 last:border-0 text-sm hover:bg-slate-50 cursor-pointer"
                      onClick={() => setSelectedAssetId(a.id)}
                    >
                      <td className="py-2 font-mono text-xs">{a.assetTag}</td>
                      <td className="py-2 font-medium">{a.name}</td>
                      <td className="py-2">{a.category.name}</td>
                      <td className="py-2">{a.department?.name ?? "—"}</td>
                      <td className="py-2 text-slate-500">{a.location ?? "—"}</td>
                      <td className="py-2">
                        <StatusBadge status={a.status} />
                      </td>
                      <td className="py-2">{a.isBookable ? "Yes" : "No"}</td>
                      <td className="py-2 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedAssetId(a.id);
                          }}
                          className="text-xs text-slate-600 hover:underline"
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="flex justify-between items-center mt-4 text-sm text-slate-500">
                <span>
                  Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    className="btn-secondary text-xs px-3 py-1"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <button
                    className="btn-secondary text-xs px-3 py-1"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {selectedAssetId && (
        <AssetDetailDrawer
          assetId={selectedAssetId}
          onClose={() => setSelectedAssetId(null)}
          onStatusChanged={loadAssets}
        />
      )}
    </AppShell>
  );
}

// =======================================================================
// Registration form (custom fields render dynamically per selected category)
// =======================================================================
function RegisterAssetForm({
  categories,
  departments,
  onCreated,
}: {
  categories: CategorySummary[];
  departments: DepartmentSummary[];
  onCreated: (asset: { id: string; assetTag: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [condition, setCondition] = useState<Condition>("GOOD");
  const [location, setLocation] = useState("");
  const [isBookable, setIsBookable] = useState(false);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const customFields = selectedCategory?.customFields ?? [];

  function setCustomFieldValue(key: string, value: any) {
    setCustomFieldValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const cleanedCustomFields = Object.fromEntries(
        Object.entries(customFieldValues).filter(([, v]) => v !== "" && v !== undefined)
      );
      const asset = await api<{ id: string; assetTag: string; name: string }>("/assets", {
        method: "POST",
        body: {
          name,
          categoryId,
          departmentId: departmentId || undefined,
          serialNumber: serialNumber || undefined,
          qrCode: qrCode || undefined,
          acquisitionDate: acquisitionDate || undefined,
          acquisitionCost: acquisitionCost ? Number(acquisitionCost) : undefined,
          condition,
          location: location || undefined,
          isBookable,
          customFieldValues: Object.keys(cleanedCustomFields).length > 0 ? cleanedCustomFields : undefined,
        },
      });
      onCreated(asset);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to register asset");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 mt-6 space-y-3 max-w-2xl">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">New Asset</p>

      <div className="grid grid-cols-2 gap-3">
        <input
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Asset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setCustomFieldValues({});
          }}
          required
        >
          <option value="">Select category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">No department (unassigned)</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={condition}
          onChange={(e) => setCondition(e.target.value as Condition)}
        >
          {CONDITION_VALUES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <input
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="Serial number (optional)"
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder="QR code (optional)"
          value={qrCode}
          onChange={(e) => setQrCode(e.target.value)}
        />

        <div>
          <label className="text-xs text-slate-500">Acquisition date</label>
          <input
            type="date"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={acquisitionDate}
            onChange={(e) => setAcquisitionDate(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">Acquisition cost (reporting only)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={acquisitionCost}
            onChange={(e) => setAcquisitionCost(e.target.value)}
          />
        </div>

        <input
          className="rounded-md border border-slate-300 px-3 py-2 text-sm col-span-2"
          placeholder="Location (e.g. Building A, Floor 3)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>

      <label className="flex items-center gap-1.5 text-sm text-slate-600">
        <input type="checkbox" checked={isBookable} onChange={(e) => setIsBookable(e.target.checked)} />
        Shared / bookable resource
      </label>

      {customFields.length > 0 && (
        <div className="border-t border-slate-100 pt-3">
          <p className="text-xs font-medium text-slate-500 mb-2">{selectedCategory?.name} fields</p>
          <div className="grid grid-cols-2 gap-3">
            {customFields.map((field) => (
              <div key={field.key}>
                <label className="text-xs text-slate-500">{field.label}</label>
                {field.type === "boolean" ? (
                  <select
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={customFieldValues[field.key] ?? ""}
                    onChange={(e) => setCustomFieldValue(field.key, e.target.value === "true")}
                  >
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={customFieldValues[field.key] ?? ""}
                    onChange={(e) => setCustomFieldValue(field.key, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {formError && <p className="text-sm text-red-600">{formError}</p>}
      <button type="submit" disabled={saving} className="btn-primary">
        {saving ? "Registering..." : "Register Asset"}
      </button>
    </form>
  );
}

// =======================================================================
// Detail drawer — basic info, custom fields, attachments, status change,
// allocation history, maintenance history
// =======================================================================
function AssetDetailDrawer({
  assetId,
  onClose,
  onStatusChanged,
}: {
  assetId: string;
  onClose: () => void;
  onStatusChanged: () => void;
}) {
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [allocationHistory, setAllocationHistory] = useState<AllocationHistoryEntry[]>([]);
  const [maintenanceHistory, setMaintenanceHistory] = useState<MaintenanceHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nextStatus, setNextStatus] = useState<AssetStatus | "">("");
  const [reason, setReason] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      api<AssetDetail>(`/assets/${assetId}`),
      api<AllocationHistoryEntry[]>(`/assets/${assetId}/allocations`),
      api<MaintenanceHistoryEntry[]>(`/assets/${assetId}/maintenance`),
    ])
      .then(([a, allocations, maintenance]) => {
        setAsset(a);
        setAllocationHistory(allocations);
        setMaintenanceHistory(maintenance);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load asset"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [assetId]);

  const allowedNextStatuses = useMemo(
    () => (asset ? ALLOWED_STATUS_TRANSITIONS[asset.status] ?? [] : []),
    [asset]
  );

  async function handleStatusChange(e: React.FormEvent) {
    e.preventDefault();
    if (!nextStatus) return;
    setStatusError(null);
    setChangingStatus(true);
    try {
      await api(`/assets/${assetId}/status`, {
        method: "POST",
        body: { status: nextStatus, reason: reason || undefined },
      });
      setNextStatus("");
      setReason("");
      load();
      onStatusChanged();
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.message : "Failed to change status");
    } finally {
      setChangingStatus(false);
    }
  }

  const activeAllocation = asset?.allocations?.[0];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-white h-full overflow-y-auto shadow-xl p-6">
        <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-600 mb-4">
          ✕ Close
        </button>

        {loading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {asset && (
          <>
            <div className="flex items-start justify-between mb-1">
              <div>
                <p className="text-xs font-mono text-slate-400">{asset.assetTag}</p>
                <h2 className="text-xl font-semibold">{asset.name}</h2>
              </div>
              <StatusBadge status={asset.status} />
            </div>
            <p className="text-sm text-slate-500 mb-5">{asset.category.name}</p>

            {activeAllocation && (
              <div className="rounded-md bg-slate-50 px-3 py-2 text-sm mb-4">
                Currently held by{" "}
                <span className="font-medium">
                  {activeAllocation.holderEmployee?.name ?? activeAllocation.holderDepartment?.name}
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mb-5">
              <Field label="Serial Number" value={asset.serialNumber ?? "—"} />
              <Field label="QR Code" value={asset.qrCode ?? "—"} />
              <Field label="Location" value={asset.location ?? "—"} />
              <Field label="Department" value={asset.department?.name ?? "—"} />
              <Field label="Condition" value={asset.condition} />
              <Field label="Bookable" value={asset.isBookable ? "Yes" : "No"} />
              <Field
                label="Acquisition Date"
                value={asset.acquisitionDate ? new Date(asset.acquisitionDate).toLocaleDateString() : "—"}
              />
              <Field
                label="Acquisition Cost"
                value={asset.acquisitionCost != null ? `$${asset.acquisitionCost.toLocaleString()}` : "—"}
              />
              <Field label="Registered By" value={asset.registeredBy.name} />
            </div>

            {asset.category.customFields && asset.category.customFields.length > 0 && (
              <div className="mb-5">
                <p className="text-xs font-medium text-slate-500 mb-2">{asset.category.name} details</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {asset.category.customFields.map((f) => (
                    <Field
                      key={f.key}
                      label={f.label}
                      value={
                        asset.customFieldValues?.[f.key] === undefined ||
                        asset.customFieldValues?.[f.key] === null ||
                        asset.customFieldValues?.[f.key] === ""
                          ? "—"
                          : String(asset.customFieldValues[f.key])
                      }
                    />
                  ))}
                </div>
              </div>
            )}

            {asset.attachments.length > 0 && (
              <div className="mb-5">
                <p className="text-xs font-medium text-slate-500 mb-2">Attachments</p>
                <ul className="text-sm space-y-1">
                  {asset.attachments.map((att) => (
                    <li key={att.id}>
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-slate-600 hover:underline"
                      >
                        {att.fileName ?? att.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Manual status change */}
            <div className="border-t border-slate-100 pt-4 mb-5">
              <p className="text-xs font-medium text-slate-500 mb-2">Change Status</p>
              {allowedNextStatuses.length === 0 ? (
                <p className="text-xs text-slate-400">No manual transitions available from {asset.status}.</p>
              ) : (
                <form onSubmit={handleStatusChange} className="flex flex-wrap gap-2 items-start">
                  <select
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm"
                    value={nextStatus}
                    onChange={(e) => setNextStatus(e.target.value as AssetStatus)}
                  >
                    <option value="">Select new status</option>
                    {allowedNextStatuses.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                  <input
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm flex-1 min-w-[160px]"
                    placeholder="Reason (optional)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <button type="submit" disabled={!nextStatus || changingStatus} className="btn-primary">
                    {changingStatus ? "Saving..." : "Apply"}
                  </button>
                </form>
              )}
              {statusError && <p className="text-sm text-red-600 mt-2">{statusError}</p>}
            </div>

            {/* Allocation history */}
            <div className="mb-5">
              <p className="text-xs font-medium text-slate-500 mb-2">Allocation History</p>
              {allocationHistory.length === 0 ? (
                <p className="text-xs text-slate-400">No allocations yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr className="text-left text-slate-400 text-xs border-b border-slate-100">
                      <th className="pb-1.5">Holder</th>
                      <th className="pb-1.5">Allocated</th>
                      <th className="pb-1.5">Returned</th>
                      <th className="pb-1.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocationHistory.map((h) => (
                      <tr key={h.id} className="border-b border-slate-50 last:border-0 text-xs">
                        <td className="py-1.5">{h.holderEmployee?.name ?? h.holderDepartment?.name}</td>
                        <td className="py-1.5">{new Date(h.allocatedAt).toLocaleDateString()}</td>
                        <td className="py-1.5">
                          {h.actualReturnDate ? new Date(h.actualReturnDate).toLocaleDateString() : "—"}
                        </td>
                        <td className="py-1.5">
                          <StatusBadge status={h.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Maintenance history */}
            <div>
              <p className="text-xs font-medium text-slate-500 mb-2">Maintenance History</p>
              {maintenanceHistory.length === 0 ? (
                <p className="text-xs text-slate-400">No maintenance requests yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr className="text-left text-slate-400 text-xs border-b border-slate-100">
                      <th className="pb-1.5">Raised By</th>
                      <th className="pb-1.5">Issue</th>
                      <th className="pb-1.5">Status</th>
                      <th className="pb-1.5">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {maintenanceHistory.map((m) => (
                      <tr key={m.id} className="border-b border-slate-50 last:border-0 text-xs">
                        <td className="py-1.5">{m.raisedBy?.name ?? "—"}</td>
                        <td className="py-1.5">{m.issueDescription ?? m.description ?? "—"}</td>
                        <td className="py-1.5">{m.status ? <StatusBadge status={m.status} /> : "—"}</td>
                        <td className="py-1.5">
                          {m.createdAt ? new Date(m.createdAt).toLocaleDateString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
