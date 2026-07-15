const STATUS_STYLES: Record<string, string> = {
  // Active/Inactive (departments, employees)
  ACTIVE: "bg-emerald-50 text-emerald-700",
  INACTIVE: "bg-slate-100 text-slate-500",

  // Roles
  ADMIN: "bg-violet-50 text-violet-700",
  ASSET_MANAGER: "bg-blue-50 text-blue-700",
  DEPARTMENT_HEAD: "bg-amber-50 text-amber-700",
  EMPLOYEE: "bg-slate-100 text-slate-600",

  // Asset lifecycle
  AVAILABLE: "bg-emerald-50 text-emerald-700",
  ALLOCATED: "bg-blue-50 text-blue-700",
  RESERVED: "bg-amber-50 text-amber-700",
  UNDER_MAINTENANCE: "bg-orange-50 text-orange-700",
  LOST: "bg-red-50 text-red-700",
  RETIRED: "bg-slate-100 text-slate-500",
  DISPOSED: "bg-slate-100 text-slate-400",

  // Allocation status
  RETURNED: "bg-slate-100 text-slate-500",
  CANCELLED: "bg-slate-100 text-slate-400",

  // Transfer request status
  REQUESTED: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",

  // Booking status
  UPCOMING: "bg-blue-50 text-blue-700",
  ONGOING: "bg-amber-50 text-amber-700",

  // Maintenance status
  PENDING: "bg-amber-50 text-amber-700",
  TECHNICIAN_ASSIGNED: "bg-blue-50 text-blue-700",
  IN_PROGRESS: "bg-orange-50 text-orange-700",
  RESOLVED: "bg-emerald-50 text-emerald-700",
};

const DEFAULT_STYLE = "bg-slate-100 text-slate-500";

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? DEFAULT_STYLE;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
