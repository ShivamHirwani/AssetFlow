"use client";

import { type ReactNode, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/org-setup", label: "Organization Setup", roles: ["ADMIN"] },
  { href: "/assets", label: "Assets" },
  { href: "/allocations", label: "Allocation & Transfer" },
  { href: "/bookings", label: "Resource Booking" },
  { href: "/maintenance", label: "Maintenance" },
  { href: "/audits", label: "Audit" },
  { href: "/reports", label: "Reports", roles: ["ADMIN", "ASSET_MANAGER", "DEPARTMENT_HEAD"] },
  { href: "/notifications", label: "Notifications" },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-5 py-5 border-b border-slate-100">
          <span className="text-lg font-semibold">AssetFlow</span>
        </div>

        <nav className="flex-1 py-3">
          {NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(user.role)).map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-5 py-2.5 text-sm ${
                  active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-5 py-4 border-t border-slate-100">
          <p className="text-sm font-medium truncate">{user.name}</p>
          <p className="text-xs text-slate-400 mb-2">{user.role}</p>
          <button onClick={logout} className="text-xs text-slate-500 hover:underline">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
