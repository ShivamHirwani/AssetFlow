import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Scope resolution — mirrors dashboard/routes.ts's pattern. Reports are
// a manager-facing surface: Admin/Asset Manager see org-wide or a single
// department via ?departmentId=; Department Head is forced to the
// department(s) they head; Employee has no access at all (the spec
// frames this screen as "give managers actionable insight").
// ---------------------------------------------------------------------
type Scope = { kind: "ORG" } | { kind: "DEPARTMENT"; departmentIds: string[] };

async function resolveReportScope(
  request: any,
  queryDepartmentId?: string
): Promise<{ ok: true; scope: Scope } | { ok: false; error: string; code?: number }> {
  const role = request.user.role as string;
  const userId = request.user.sub as string;

  if (role === "ADMIN" || role === "ASSET_MANAGER") {
    if (queryDepartmentId) {
      const department = await prisma.department.findUnique({ where: { id: queryDepartmentId } });
      if (!department) {
        return { ok: false, error: "departmentId does not reference an existing department" };
      }
      return { ok: true, scope: { kind: "DEPARTMENT", departmentIds: [queryDepartmentId] } };
    }
    return { ok: true, scope: { kind: "ORG" } };
  }

  if (role === "DEPARTMENT_HEAD") {
    const headed = await prisma.department.findMany({ where: { headId: userId }, select: { id: true } });
    const departmentIds = headed.map((d) => d.id);
    if (departmentIds.length === 0) {
      return { ok: false, error: "You are not assigned as head of any department", code: 403 };
    }
    if (queryDepartmentId) {
      if (!departmentIds.includes(queryDepartmentId)) {
        return { ok: false, error: "You can only view reports for a department you head", code: 403 };
      }
      return { ok: true, scope: { kind: "DEPARTMENT", departmentIds: [queryDepartmentId] } };
    }
    return { ok: true, scope: { kind: "DEPARTMENT", departmentIds } };
  }

  return {
    ok: false,
    error: "Forbidden — Reports & Analytics is limited to Admin, Asset Manager, and Department Head",
    code: 403,
  };
}

function assetWhereForScope(scope: Scope, categoryId?: string) {
  const where: any = {};
  if (scope.kind === "DEPARTMENT") where.departmentId = { in: scope.departmentIds };
  if (categoryId) where.categoryId = categoryId;
  return where;
}

// ---------------------------------------------------------------------
// CSV helper — small hand-rolled serializer rather than a dependency,
// since the shape of each report is just a flat array of records.
// ---------------------------------------------------------------------
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(","));
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------
const utilizationQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  categoryId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const maintenanceFrequencyQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  groupBy: z.enum(["asset", "category"]).default("category"),
});

const lifecycleAttentionQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  lifespanYears: z.coerce.number().min(1).max(50).default(5),
  maintenanceDueDays: z.coerce.number().int().min(1).max(3650).default(180),
});

const bookingHeatmapQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  assetId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const exportQuerySchema = z.object({
  report: z.enum([
    "asset-utilization",
    "maintenance-frequency",
    "lifecycle-attention",
    "department-summary",
    "booking-heatmap",
  ]),
  format: z.enum(["csv"]).default("csv"),
});

// ---------------------------------------------------------------------
// Report builders — plain functions so the JSON routes and the CSV
// export endpoint can share the exact same computation.
// ---------------------------------------------------------------------

async function buildUtilizationReport(
  scope: Scope,
  params: { categoryId?: string; from: Date; to: Date; limit: number }
) {
  const { categoryId, from, to, limit } = params;

  const assets = await prisma.asset.findMany({
    where: assetWhereForScope(scope, categoryId),
    select: { id: true, assetTag: true, name: true, status: true, category: { select: { name: true } } },
  });
  const assetIds = assets.map((a) => a.id);
  if (assetIds.length === 0) {
    return { from, to, mostUsed: [], idle: [] };
  }

  // Any allocation whose active window overlaps [from, to].
  const allocations = await prisma.allocation.findMany({
    where: {
      assetId: { in: assetIds },
      allocatedAt: { lte: to },
      OR: [{ actualReturnDate: null }, { actualReturnDate: { gte: from } }],
    },
    select: { assetId: true, allocatedAt: true, actualReturnDate: true },
  });

  const bookings = await prisma.booking.findMany({
    where: { assetId: { in: assetIds }, cancelledAt: null, startTime: { gte: from, lte: to } },
    select: { assetId: true },
  });

  const daysAllocatedByAsset = new Map<string, number>();
  const allocationCountByAsset = new Map<string, number>();
  for (const alloc of allocations) {
    const windowStart = Math.max(alloc.allocatedAt.getTime(), from.getTime());
    const windowEnd = Math.min((alloc.actualReturnDate ?? to).getTime(), to.getTime());
    const overlapDays = Math.max(0, (windowEnd - windowStart) / DAY_MS);
    daysAllocatedByAsset.set(alloc.assetId, (daysAllocatedByAsset.get(alloc.assetId) ?? 0) + overlapDays);
    allocationCountByAsset.set(alloc.assetId, (allocationCountByAsset.get(alloc.assetId) ?? 0) + 1);
  }

  const bookingCountByAsset = new Map<string, number>();
  for (const b of bookings) {
    bookingCountByAsset.set(b.assetId, (bookingCountByAsset.get(b.assetId) ?? 0) + 1);
  }

  const rows = assets.map((a) => {
    const daysAllocated = Math.round((daysAllocatedByAsset.get(a.id) ?? 0) * 10) / 10;
    const allocationCount = allocationCountByAsset.get(a.id) ?? 0;
    const bookingCount = bookingCountByAsset.get(a.id) ?? 0;
    return {
      assetId: a.id,
      assetTag: a.assetTag,
      name: a.name,
      category: a.category.name,
      status: a.status,
      daysAllocated,
      allocationCount,
      bookingCount,
      usageScore: daysAllocated + bookingCount,
    };
  });

  const mostUsed = [...rows].sort((x, y) => y.usageScore - x.usageScore).slice(0, limit);
  const idle = rows.filter((r) => r.usageScore === 0);

  return { from, to, mostUsed, idle };
}

async function buildMaintenanceFrequencyReport(
  scope: Scope,
  params: { from: Date; to: Date; groupBy: "asset" | "category" }
) {
  const { from, to, groupBy } = params;

  const assetWhere = assetWhereForScope(scope);
  const requests = await prisma.maintenanceRequest.findMany({
    where: { createdAt: { gte: from, lte: to }, asset: assetWhere },
    select: {
      status: true,
      priority: true,
      asset: { select: { id: true, assetTag: true, name: true, category: { select: { id: true, name: true } } } },
    },
  });

  const groups = new Map<string, { key: string; label: string; total: number; byStatus: Record<string, number> }>();
  for (const r of requests) {
    const key = groupBy === "asset" ? r.asset.id : r.asset.category.id;
    const label = groupBy === "asset" ? `${r.asset.name} (${r.asset.assetTag})` : r.asset.category.name;
    if (!groups.has(key)) groups.set(key, { key, label, total: 0, byStatus: {} });
    const g = groups.get(key)!;
    g.total += 1;
    g.byStatus[r.status] = (g.byStatus[r.status] ?? 0) + 1;
  }

  return { from, to, groupBy, groups: [...groups.values()].sort((a, b) => b.total - a.total) };
}

async function buildLifecycleAttentionReport(
  scope: Scope,
  params: { lifespanYears: number; maintenanceDueDays: number }
) {
  const { lifespanYears, maintenanceDueDays } = params;
  const now = new Date();

  const assets = await prisma.asset.findMany({
    where: { ...assetWhereForScope(scope), status: { notIn: ["RETIRED", "DISPOSED"] } },
    select: { id: true, assetTag: true, name: true, status: true, acquisitionDate: true, createdAt: true },
  });
  const assetIds = assets.map((a) => a.id);

  const lastResolved =
    assetIds.length > 0
      ? await prisma.maintenanceRequest.groupBy({
          by: ["assetId"],
          where: { assetId: { in: assetIds }, status: "RESOLVED" },
          _max: { resolvedAt: true },
        })
      : [];
  const lastResolvedByAsset = new Map(lastResolved.map((r) => [r.assetId, r._max.resolvedAt]));

  const nearingRetirement: any[] = [];
  const overdueForRetirement: any[] = [];
  const dueForMaintenance: any[] = [];

  const msPerYear = 365.25 * DAY_MS;
  const nearingThresholdMs = (lifespanYears - 1) * msPerYear;
  const overdueThresholdMs = lifespanYears * msPerYear;
  const maintenanceDueThresholdMs = maintenanceDueDays * DAY_MS;

  for (const a of assets) {
    if (a.acquisitionDate) {
      const ageMs = now.getTime() - a.acquisitionDate.getTime();
      const ageYears = Math.round((ageMs / msPerYear) * 10) / 10;
      const entry = { assetId: a.id, assetTag: a.assetTag, name: a.name, acquisitionDate: a.acquisitionDate, ageYears };
      if (ageMs >= overdueThresholdMs) overdueForRetirement.push(entry);
      else if (ageMs >= nearingThresholdMs) nearingRetirement.push(entry);
    }

    if (["AVAILABLE", "ALLOCATED", "RESERVED"].includes(a.status)) {
      const lastServiced = lastResolvedByAsset.get(a.id) ?? a.acquisitionDate ?? a.createdAt;
      const sinceServiceMs = now.getTime() - lastServiced.getTime();
      if (sinceServiceMs >= maintenanceDueThresholdMs) {
        dueForMaintenance.push({
          assetId: a.id,
          assetTag: a.assetTag,
          name: a.name,
          lastServiced,
          daysSinceServiced: Math.round(sinceServiceMs / DAY_MS),
        });
      }
    }
  }

  overdueForRetirement.sort((x, y) => y.ageYears - x.ageYears);
  nearingRetirement.sort((x, y) => y.ageYears - x.ageYears);
  dueForMaintenance.sort((x, y) => y.daysSinceServiced - x.daysSinceServiced);

  return {
    assumptions: { lifespanYears, maintenanceDueDays },
    overdueForRetirement,
    nearingRetirement,
    dueForMaintenance,
  };
}

async function buildDepartmentSummaryReport(scope: Scope) {
  const departments = await prisma.department.findMany({
    where: scope.kind === "DEPARTMENT" ? { id: { in: scope.departmentIds } } : {},
    select: { id: true, name: true, status: true },
    orderBy: { name: "asc" },
  });

  const rows = await Promise.all(
    departments.map(async (dept) => {
      const [assetsOwned, activeAsHolder, activeToEmployees, totalHistorical] = await prisma.$transaction([
        prisma.asset.count({ where: { departmentId: dept.id } }),
        prisma.allocation.count({ where: { status: "ACTIVE", holderDepartmentId: dept.id } }),
        prisma.allocation.count({
          where: { status: "ACTIVE", holderEmployee: { departmentId: dept.id } },
        }),
        prisma.allocation.count({
          where: { OR: [{ holderDepartmentId: dept.id }, { holderEmployee: { departmentId: dept.id } }] },
        }),
      ]);
      return {
        departmentId: dept.id,
        departmentName: dept.name,
        status: dept.status,
        assetsOwned,
        activeAllocationsAsHolder: activeAsHolder,
        activeAllocationsToEmployees: activeToEmployees,
        totalAllocationsHistorical: totalHistorical,
      };
    })
  );

  return { departments: rows.sort((a, b) => b.totalAllocationsHistorical - a.totalAllocationsHistorical) };
}

async function buildBookingHeatmapReport(scope: Scope, params: { assetId?: string; from: Date; to: Date }) {
  const { assetId, from, to } = params;

  const where: any = { cancelledAt: null, startTime: { gte: from, lte: to } };
  if (assetId) where.assetId = assetId;
  if (scope.kind === "DEPARTMENT") where.asset = { departmentId: { in: scope.departmentIds } };

  const bookings = await prisma.booking.findMany({ where, select: { startTime: true } });

  // grid[dayOfWeek][hourOfDay] — Sunday = 0, server-local time.
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const b of bookings) {
    grid[b.startTime.getDay()][b.startTime.getHours()] += 1;
  }

  let peak = { dayOfWeek: 0, hour: 0, count: 0 };
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      if (grid[d][h] > peak.count) peak = { dayOfWeek: d, hour: h, count: grid[d][h] };
    }
  }

  return { from, to, totalBookings: bookings.length, grid, peak };
}

export async function reportRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];

  app.get("/asset-utilization", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = utilizationQuerySchema.parse(request.query);
    const scopeResult = await resolveReportScope(request, query.departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });

    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 90 * DAY_MS);
    return buildUtilizationReport(scopeResult.scope, { categoryId: query.categoryId, from, to, limit: query.limit });
  });

  app.get("/maintenance-frequency", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = maintenanceFrequencyQuerySchema.parse(request.query);
    const scopeResult = await resolveReportScope(request, query.departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });

    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 180 * DAY_MS);
    return buildMaintenanceFrequencyReport(scopeResult.scope, { from, to, groupBy: query.groupBy });
  });

  app.get("/lifecycle-attention", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = lifecycleAttentionQuerySchema.parse(request.query);
    const scopeResult = await resolveReportScope(request, query.departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });

    return buildLifecycleAttentionReport(scopeResult.scope, {
      lifespanYears: query.lifespanYears,
      maintenanceDueDays: query.maintenanceDueDays,
    });
  });

  app.get("/department-summary", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const departmentId = (request.query as any).departmentId as string | undefined;
    const scopeResult = await resolveReportScope(request, departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });

    return buildDepartmentSummaryReport(scopeResult.scope);
  });

  app.get("/booking-heatmap", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = bookingHeatmapQuerySchema.parse(request.query);
    const scopeResult = await resolveReportScope(request, query.departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });

    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 90 * DAY_MS);
    return buildBookingHeatmapReport(scopeResult.scope, { assetId: query.assetId, from, to });
  });

  // ---- CSV export — reuses the same builders, just flattens + re-serves ----
  app.get("/export", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { report } = exportQuerySchema.parse(request.query);
    const rawQuery = request.query as Record<string, string>;
    const departmentId = rawQuery.departmentId;

    const scopeResult = await resolveReportScope(request, departmentId);
    if (!scopeResult.ok) return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });
    const scope = scopeResult.scope;

    const to = rawQuery.to ? new Date(rawQuery.to) : new Date();
    const from = rawQuery.from ? new Date(rawQuery.from) : new Date(to.getTime() - 90 * DAY_MS);

    let rows: Record<string, unknown>[] = [];

    switch (report) {
      case "asset-utilization": {
        const data = await buildUtilizationReport(scope, {
          categoryId: rawQuery.categoryId,
          from,
          to,
          limit: rawQuery.limit ? Number(rawQuery.limit) : 100,
        });
        rows = [
          ...data.mostUsed.map((r) => ({ ...r, bucket: "most_used" })),
          ...data.idle.map((r) => ({ ...r, bucket: "idle" })),
        ];
        break;
      }
      case "maintenance-frequency": {
        const data = await buildMaintenanceFrequencyReport(scope, {
          from,
          to,
          groupBy: (rawQuery.groupBy as "asset" | "category") ?? "category",
        });
        rows = data.groups.map((g) => ({ key: g.key, label: g.label, total: g.total, ...g.byStatus }));
        break;
      }
      case "lifecycle-attention": {
        const data = await buildLifecycleAttentionReport(scope, {
          lifespanYears: rawQuery.lifespanYears ? Number(rawQuery.lifespanYears) : 5,
          maintenanceDueDays: rawQuery.maintenanceDueDays ? Number(rawQuery.maintenanceDueDays) : 180,
        });
        rows = [
          ...data.overdueForRetirement.map((r) => ({ ...r, bucket: "overdue_for_retirement" })),
          ...data.nearingRetirement.map((r) => ({ ...r, bucket: "nearing_retirement" })),
          ...data.dueForMaintenance.map((r) => ({ ...r, bucket: "due_for_maintenance" })),
        ];
        break;
      }
      case "department-summary": {
        const data = await buildDepartmentSummaryReport(scope);
        rows = data.departments;
        break;
      }
      case "booking-heatmap": {
        const data = await buildBookingHeatmapReport(scope, { assetId: rawQuery.assetId, from, to });
        for (let d = 0; d < 7; d++) {
          for (let h = 0; h < 24; h++) {
            rows.push({ dayOfWeek: d, hour: h, count: data.grid[d][h] });
          }
        }
        break;
      }
    }

    const csv = toCsv(rows);
    reply.header("Content-Type", "text/csv");
    reply.header("Content-Disposition", `attachment; filename="${report}.csv"`);
    return reply.send(csv);
  });
}
