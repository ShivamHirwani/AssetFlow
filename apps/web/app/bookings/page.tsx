"use client";

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { StatusBadge } from "@/lib/status-badge";
import { useAuth } from "@/lib/auth";

// =======================================================================
// Types
// =======================================================================
type BookingStatus = "UPCOMING" | "ONGOING" | "COMPLETED" | "CANCELLED";

type AssetOption = {
  id: string;
  assetTag: string;
  name: string;
  isBookable: boolean;
  status: string;
  location: string | null;
};

type DepartmentOption = { id: string; name: string };

type Booking = {
  id: string;
  startTime: string;
  endTime: string;
  purpose: string | null;
  status: BookingStatus;
  cancelReason?: string | null;
  asset: { id: string; assetTag: string; name: string; location: string | null };
  requestedBy: { id: string; name: string; email: string };
  onBehalfOfDepartment: { id: string; name: string } | null;
};

const CAN_BOOK_ON_BEHALF = ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"];

function toDateInputValue(d: Date) {
  return d.toISOString().slice(0, 10);
}

function startOfDay(dateStr: string) {
  return new Date(`${dateStr}T00:00:00`);
}

function endOfDay(dateStr: string) {
  return new Date(`${dateStr}T23:59:59.999`);
}

// =======================================================================
// Main page
// =======================================================================
export default function BookingsPage() {
  const { user } = useAuth();

  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");
  const [viewDate, setViewDate] = useState(toDateInputValue(new Date()));

  const [dayBookings, setDayBookings] = useState<Booking[]>([]);
  const [dayLoading, setDayLoading] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ total: number; assets: AssetOption[] }>("/assets", {
      query: { isBookable: "true", pageSize: 100 },
    })
      .then((res) => {
        setAssets(res.assets);
        if (!selectedAssetId && res.assets.length > 0) setSelectedAssetId(res.assets[0].id);
      })
      .catch(() => setAssets([]));
    api<DepartmentOption[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedAssetId) return;
    setDayLoading(true);
    api<{ bookings: Booking[] }>("/bookings", {
      query: {
        assetId: selectedAssetId,
        from: startOfDay(viewDate).toISOString(),
        to: endOfDay(viewDate).toISOString(),
        pageSize: 100,
      },
    })
      .then((res) => setDayBookings(res.bookings))
      .catch(() => setDayBookings([]))
      .finally(() => setDayLoading(false));
  }, [selectedAssetId, viewDate, refreshKey]);

  const selectedAsset = assets.find((a) => a.id === selectedAssetId);

  function shiftDay(delta: number) {
    const d = startOfDay(viewDate);
    d.setDate(d.getDate() + delta);
    setViewDate(toDateInputValue(d));
  }

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto p-8">
        <div className="flex justify-between items-start mb-1">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Resource Booking</h1>
            <p className="text-sm text-slate-500">
              Time-slot booking of shared resources with no overlaps.
            </p>
          </div>
          <button
            onClick={() => {
              setShowForm(!showForm);
              setSuccessMessage(null);
            }}
            className="btn-primary"
          >
            {showForm ? "Cancel" : "+ Book Resource"}
          </button>
        </div>

        {successMessage && (
          <p className="text-sm text-emerald-600 bg-emerald-50 rounded-md px-3 py-2 mt-4">
            {successMessage}
          </p>
        )}

        {showForm && (
          <NewBookingForm
            assets={assets}
            departments={departments}
            defaultAssetId={selectedAssetId}
            canBookOnBehalf={CAN_BOOK_ON_BEHALF.includes(user?.role ?? "")}
            onCreated={() => {
              setShowForm(false);
              setSuccessMessage("Booking confirmed.");
              setRefreshKey((k) => k + 1);
            }}
          />
        )}

        {/* Resource + date picker */}
        <div className="card p-4 mt-6 mb-4 flex flex-wrap gap-3 items-center">
          <select
            className="rounded-md border border-slate-300 px-3 py-2 text-sm min-w-[220px]"
            value={selectedAssetId}
            onChange={(e) => setSelectedAssetId(e.target.value)}
          >
            {assets.length === 0 && <option value="">No bookable resources</option>}
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.assetTag} — {a.name}
                {a.location ? ` (${a.location})` : ""}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <button onClick={() => shiftDay(-1)} className="btn-secondary text-xs px-3 py-1">
              ← Prev
            </button>
            <input
              type="date"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={viewDate}
              onChange={(e) => setViewDate(e.target.value)}
            />
            <button onClick={() => shiftDay(1)} className="btn-secondary text-xs px-3 py-1">
              Next →
            </button>
            <button onClick={() => setViewDate(toDateInputValue(new Date()))} className="text-xs text-slate-500 hover:underline">
              Today
            </button>
          </div>
        </div>

        {/* Day schedule / calendar view for the selected resource */}
        <div className="card p-5 mb-8">
          <p className="text-sm font-medium mb-3">
            {selectedAsset ? `${selectedAsset.name} — ${new Date(viewDate).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}` : "Select a resource"}
          </p>
          {dayLoading ? (
            <p className="text-sm text-slate-400">Loading schedule...</p>
          ) : (
            <DaySchedule bookings={dayBookings} />
          )}
        </div>

        {/* All bookings, filterable */}
        <BookingsTable
          assets={assets}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
      </div>
    </AppShell>
  );
}

// =======================================================================
// Day schedule — simple vertical timeline, one column, blocks positioned
// by time-of-day. Booking.status is already the derived value from the
// API (UPCOMING/ONGOING/COMPLETED/CANCELLED).
// =======================================================================
const HOUR_HEIGHT = 32; // px per hour
const START_HOUR = 6; // 6am
const END_HOUR = 22; // 10pm — covers typical business hours; earlier/later
// bookings still render, just clipped at the top/bottom of the visible band.

function minutesFromMidnight(d: Date) {
  return d.getHours() * 60 + d.getMinutes();
}

function DaySchedule({ bookings }: { bookings: Booking[] }) {
  const visibleHeight = (END_HOUR - START_HOUR) * HOUR_HEIGHT;
  const hours = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, i) => START_HOUR + i);

  const activeBookings = bookings.filter((b) => b.status !== "CANCELLED");

  return (
    <div className="flex text-xs">
      <div className="w-14 shrink-0 relative" style={{ height: visibleHeight }}>
        {hours.map((h) => (
          <div
            key={h}
            className="absolute text-slate-400 -translate-y-1/2"
            style={{ top: (h - START_HOUR) * HOUR_HEIGHT }}
          >
            {h % 12 === 0 ? 12 : h % 12}
            {h < 12 ? "am" : "pm"}
          </div>
        ))}
      </div>
      <div className="flex-1 relative border-l border-slate-100" style={{ height: visibleHeight }}>
        {hours.map((h) => (
          <div
            key={h}
            className="absolute w-full border-t border-slate-50"
            style={{ top: (h - START_HOUR) * HOUR_HEIGHT }}
          />
        ))}
        {activeBookings.length === 0 && (
          <p className="absolute inset-x-0 top-4 text-center text-slate-300">No bookings on this day</p>
        )}
        {activeBookings.map((b) => {
          const start = new Date(b.startTime);
          const end = new Date(b.endTime);
          const top = Math.max(0, (minutesFromMidnight(start) - START_HOUR * 60) / 60) * HOUR_HEIGHT;
          const rawHeight =
            ((minutesFromMidnight(end) - minutesFromMidnight(start)) / 60) * HOUR_HEIGHT;
          const height = Math.max(18, rawHeight);
          const color = b.status === "ONGOING" ? "bg-amber-100 border-amber-300 text-amber-800" : "bg-blue-100 border-blue-300 text-blue-800";
          return (
            <div
              key={b.id}
              className={`absolute left-2 right-2 rounded-md border px-2 py-1 overflow-hidden ${color}`}
              style={{ top, height }}
              title={`${b.requestedBy.name} — ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            >
              <p className="font-medium truncate">
                {start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}–
                {end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </p>
              <p className="truncate">
                {b.onBehalfOfDepartment?.name ?? b.requestedBy.name}
                {b.purpose ? ` — ${b.purpose}` : ""}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =======================================================================
// New booking form
// =======================================================================
function NewBookingForm({
  assets,
  departments,
  defaultAssetId,
  canBookOnBehalf,
  onCreated,
}: {
  assets: AssetOption[];
  departments: DepartmentOption[];
  defaultAssetId: string;
  canBookOnBehalf: boolean;
  onCreated: () => void;
}) {
  const [assetId, setAssetId] = useState(defaultAssetId);
  const [date, setDate] = useState(toDateInputValue(new Date()));
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [purpose, setPurpose] = useState("");
  const [onBehalfOfDepartmentId, setOnBehalfOfDepartmentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ startTime: string; endTime: string } | null>(null);

  useEffect(() => setAssetId(defaultAssetId), [defaultAssetId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setConflict(null);
    setSaving(true);
    try {
      await api("/bookings", {
        method: "POST",
        body: {
          assetId,
          startTime: new Date(`${date}T${startTime}:00`).toISOString(),
          endTime: new Date(`${date}T${endTime}:00`).toISOString(),
          purpose: purpose || undefined,
          onBehalfOfDepartmentId: onBehalfOfDepartmentId || undefined,
        },
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err as any).conflictingBooking) {
        const c = (err as any).conflictingBooking;
        setConflict({ startTime: c.startTime, endTime: c.endTime });
        setFormError(err.message);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Failed to create booking");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 mt-6 space-y-3 max-w-xl">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">New Booking</p>

      <select
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        value={assetId}
        onChange={(e) => setAssetId(e.target.value)}
        required
      >
        <option value="">Select resource</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.assetTag} — {a.name}
            {a.location ? ` (${a.location})` : ""}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-slate-500">Date</label>
          <input
            type="date"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">Start time</label>
          <input
            type="time"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="text-xs text-slate-500">End time</label>
          <input
            type="time"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
          />
        </div>
      </div>

      <input
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="Purpose (optional)"
        value={purpose}
        onChange={(e) => setPurpose(e.target.value)}
      />

      {canBookOnBehalf && (
        <select
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={onBehalfOfDepartmentId}
          onChange={(e) => setOnBehalfOfDepartmentId(e.target.value)}
        >
          <option value="">Book for myself</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              On behalf of {d.name}
            </option>
          ))}
        </select>
      )}

      {formError && (
        <div className="text-sm text-red-600">
          <p>{formError}</p>
          {conflict && (
            <p className="text-xs text-red-500 mt-1">
              Conflicts with existing booking{" "}
              {new Date(conflict.startTime).toLocaleString()} –{" "}
              {new Date(conflict.endTime).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}

      <button type="submit" disabled={saving || !assetId} className="btn-primary">
        {saving ? "Booking..." : "Confirm Booking"}
      </button>
    </form>
  );
}

// =======================================================================
// All-bookings table — filterable, with cancel/reschedule row actions
// =======================================================================
function BookingsTable({
  assets,
  onChanged,
}: {
  assets: AssetOption[];
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [assetFilter, setAssetFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<BookingStatus | "">("");
  const [mineOnly, setMineOnly] = useState(false);

  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api<{ total: number; bookings: Booking[] }>("/bookings", {
      query: {
        assetId: assetFilter || undefined,
        status: statusFilter || undefined,
        requestedById: mineOnly ? user?.id : undefined,
        pageSize: 50,
      },
    })
      .then((res) => {
        setBookings(res.bookings);
        setTotal(res.total);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load bookings"))
      .finally(() => setLoading(false));
  }

  useEffect(load, [assetFilter, statusFilter, mineOnly]);

  function canManage(b: Booking) {
    if (!user) return false;
    if (["ADMIN", "ASSET_MANAGER"].includes(user.role)) return true;
    if (b.requestedBy.id === user.id) return true;
    return false; // Department Head on-behalf-of check happens server-side; UI still lets them try
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center mb-3">
        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={assetFilter}
          onChange={(e) => setAssetFilter(e.target.value)}
        >
          <option value="">All resources</option>
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.assetTag} — {a.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as BookingStatus | "")}
        >
          <option value="">All statuses</option>
          <option value="UPCOMING">Upcoming</option>
          <option value="ONGOING">Ongoing</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          My bookings only
        </label>
      </div>

      <div className="card p-5">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-400">Loading...</p>
        ) : bookings.length === 0 ? (
          <p className="text-sm text-slate-400">No bookings match these filters.</p>
        ) : (
          <table>
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100 text-sm">
                <th className="pb-2">Resource</th>
                <th className="pb-2">Requested By</th>
                <th className="pb-2">Start</th>
                <th className="pb-2">End</th>
                <th className="pb-2">Purpose</th>
                <th className="pb-2">Status</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <>
                  <tr key={b.id} className="border-b border-slate-50 last:border-0 text-sm">
                    <td className="py-2 font-medium">
                      {b.asset.assetTag} — {b.asset.name}
                    </td>
                    <td className="py-2">
                      {b.onBehalfOfDepartment ? `${b.onBehalfOfDepartment.name} (via ${b.requestedBy.name})` : b.requestedBy.name}
                    </td>
                    <td className="py-2">{new Date(b.startTime).toLocaleString()}</td>
                    <td className="py-2">{new Date(b.endTime).toLocaleString()}</td>
                    <td className="py-2 text-slate-500">{b.purpose ?? "—"}</td>
                    <td className="py-2">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="py-2 text-right space-x-2 whitespace-nowrap">
                      {(b.status === "UPCOMING" || b.status === "ONGOING") && canManage(b) && (
                        <>
                          <button
                            onClick={() => setReschedulingId(reschedulingId === b.id ? null : b.id)}
                            className="text-xs text-slate-600 hover:underline"
                          >
                            Reschedule
                          </button>
                          <button
                            onClick={() => setCancelingId(cancelingId === b.id ? null : b.id)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {reschedulingId === b.id && (
                    <tr className="border-b border-slate-50">
                      <td colSpan={7} className="py-3">
                        <RescheduleForm
                          booking={b}
                          onDone={() => {
                            setReschedulingId(null);
                            load();
                            onChanged();
                          }}
                          onCancelEdit={() => setReschedulingId(null)}
                        />
                      </td>
                    </tr>
                  )}
                  {cancelingId === b.id && (
                    <tr className="border-b border-slate-50">
                      <td colSpan={7} className="py-3">
                        <CancelForm
                          bookingId={b.id}
                          onDone={() => {
                            setCancelingId(null);
                            load();
                            onChanged();
                          }}
                          onCancelEdit={() => setCancelingId(null)}
                        />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
        {!loading && bookings.length > 0 && (
          <p className="text-xs text-slate-400 mt-3">Showing {bookings.length} of {total}</p>
        )}
      </div>
    </div>
  );
}

function RescheduleForm({
  booking,
  onDone,
  onCancelEdit,
}: {
  booking: Booking;
  onDone: () => void;
  onCancelEdit: () => void;
}) {
  const start = new Date(booking.startTime);
  const end = new Date(booking.endTime);
  const [date, setDate] = useState(toDateInputValue(start));
  const [startTime, setStartTime] = useState(start.toTimeString().slice(0, 5));
  const [endTime, setEndTime] = useState(end.toTimeString().slice(0, 5));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api(`/bookings/${booking.id}/reschedule`, {
        method: "POST",
        body: {
          startTime: new Date(`${date}T${startTime}:00`).toISOString(),
          endTime: new Date(`${date}T${endTime}:00`).toISOString(),
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to reschedule");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2 items-start bg-slate-50 rounded-md p-3">
      <input
        type="date"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <input
        type="time"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        value={startTime}
        onChange={(e) => setStartTime(e.target.value)}
      />
      <input
        type="time"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        value={endTime}
        onChange={(e) => setEndTime(e.target.value)}
      />
      <button type="submit" disabled={saving} className="btn-primary text-xs px-3 py-1.5">
        {saving ? "Saving..." : "Save"}
      </button>
      <button type="button" onClick={onCancelEdit} className="btn-secondary text-xs px-3 py-1.5">
        Cancel
      </button>
      {error && <p className="text-xs text-red-600 w-full">{error}</p>}
    </form>
  );
}

function CancelForm({
  bookingId,
  onDone,
  onCancelEdit,
}: {
  bookingId: string;
  onDone: () => void;
  onCancelEdit: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setSaving(true);
    try {
      await api(`/bookings/${bookingId}/cancel`, {
        method: "POST",
        body: { cancelReason: reason || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cancel booking");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2 items-start bg-red-50 rounded-md p-3">
      <input
        className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        placeholder="Cancellation reason (optional)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button onClick={handleConfirm} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white">
        {saving ? "Cancelling..." : "Confirm Cancel"}
      </button>
      <button onClick={onCancelEdit} className="btn-secondary text-xs px-3 py-1.5">
        Back
      </button>
      {error && <p className="text-xs text-red-600 w-full">{error}</p>}
    </div>
  );
}
