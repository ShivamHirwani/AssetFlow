import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

// A MaintenanceRequest counts toward "Maintenance Today" while work on it
// is actively open. Schema has no scheduled-date field to key off of, so
// this is "currently open maintenance work" rather than a literal
// same-calendar-day filter.
const ACTIVE_MAINTENANCE_STATUSES = ["APPROVED", "TECHNICIAN_ASSIGNED", "IN_PROGRESS"] as const;

const summaryQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  upcomingWindowDays: z.coerce.number().int().min(1).max(90).default(7),
});

const returnsQuerySchema = z.object({
  departmentId: z.string().cuid().optional(),
  upcomingWindowDays: z.coerce.number().int().min(1).max(90).default(7),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

type Scope =
  | { kind: "ORG" }
  | { kind: "DEPARTMENT"; departmentIds: string[] }
  | { kind: "PERSONAL"; userId: string };

/**
 * Determines what slice of the org a given request should see.
 * - Admin/Asset Manager: everything, or one department via ?departmentId=
 * - Department Head: forced to the department(s) they head (?departmentId=
 *   must be one of their own or it's rejected)
 * - Employee: forced to themselves — no departmentId override
 */
async function resolveScope(
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
    const headed = await prisma.department.findMany({
      where: { headId: userId },
      select: { id: true },
    });
    const departmentIds = headed.map((d) => d.id);

    if (queryDepartmentId) {
      if (!departmentIds.includes(queryDepartmentId)) {
        return { ok: false, error: "You can only view the dashboard for a department you head", code: 403 };
      }
      return { ok: true, scope: { kind: "DEPARTMENT", departmentIds: [queryDepartmentId] } };
    }
    return { ok: true, scope: { kind: "DEPARTMENT", departmentIds } };
  }

  // EMPLOYEE
  return { ok: true, scope: { kind: "PERSONAL", userId } };
}

const allocationInclude = {
  asset: { select: { id: true, assetTag: true, name: true } },
  holderEmployee: { select: { id: true, name: true, email: true } },
  holderDepartment: { select: { id: true, name: true } },
} as const;

export async function dashboardRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];

  // ---- KPI cards: Assets Available, Assets Allocated, Maintenance Today,
  // Active Bookings, Pending Transfers, Upcoming Returns (+ Overdue Returns
  // surfaced separately, per the spec) ----
  app.get("/summary", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = summaryQuerySchema.parse(request.query);

    const scopeResult = await resolveScope(request, query.departmentId);
    if (!scopeResult.ok) {
      return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });
    }
    const scope = scopeResult.scope;

    const now = new Date();
    const upcomingWindowEnd = new Date(now.getTime() + query.upcomingWindowDays * 24 * 60 * 60 * 1000);

    const assetWhere: any = scope.kind === "DEPARTMENT" ? { departmentId: { in: scope.departmentIds } } : {};
    const assetRelationWhere: any =
      scope.kind === "DEPARTMENT" ? { asset: { departmentId: { in: scope.departmentIds } } } : {};

    const [
      assetsAvailable,
      assetsAllocated,
      maintenanceToday,
      activeBookings,
      pendingTransfers,
      upcomingReturns,
      overdueReturns,
    ] = await Promise.all([
      // Always org-wide — useful context for booking/allocation decisions
      // regardless of who's looking.
      prisma.asset.count({
        where: { ...(scope.kind === "PERSONAL" ? {} : assetWhere), status: "AVAILABLE" },
      }),

      scope.kind === "PERSONAL"
        ? prisma.allocation.count({ where: { status: "ACTIVE", holderEmployeeId: scope.userId } })
        : prisma.asset.count({ where: { ...assetWhere, status: "ALLOCATED" } }),

      scope.kind === "PERSONAL"
        ? prisma.maintenanceRequest.count({
            where: { raisedById: scope.userId, status: { in: [...ACTIVE_MAINTENANCE_STATUSES] } },
          })
        : prisma.maintenanceRequest.count({
            where: { ...assetRelationWhere, status: { in: [...ACTIVE_MAINTENANCE_STATUSES] } },
          }),

      // Time-window query rather than the stored status field — Booking.status
      // is only ever UPCOMING/CANCELLED in the DB (see bookings/routes.ts).
      scope.kind === "PERSONAL"
        ? prisma.booking.count({
            where: {
              requestedById: scope.userId,
              cancelledAt: null,
              startTime: { lte: now },
              endTime: { gt: now },
            },
          })
        : prisma.booking.count({
            where: {
              cancelledAt: null,
              startTime: { lte: now },
              endTime: { gt: now },
              ...(scope.kind === "DEPARTMENT"
                ? {
                    OR: [
                      { asset: { departmentId: { in: scope.departmentIds } } },
                      { onBehalfOfDepartmentId: { in: scope.departmentIds } },
                    ],
                  }
                : {}),
            },
          }),

      scope.kind === "PERSONAL"
        ? prisma.transferRequest.count({ where: { requestedById: scope.userId, status: "REQUESTED" } })
        : prisma.transferRequest.count({
            where: {
              status: "REQUESTED",
              ...(scope.kind === "DEPARTMENT"
                ? {
                    OR: [
                      { asset: { departmentId: { in: scope.departmentIds } } },
                      { toHolderDepartmentId: { in: scope.departmentIds } },
                    ],
                  }
                : {}),
            },
          }),

      scope.kind === "PERSONAL"
        ? prisma.allocation.count({
            where: {
              status: "ACTIVE",
              holderEmployeeId: scope.userId,
              expectedReturnDate: { gte: now, lte: upcomingWindowEnd },
            },
          })
        : prisma.allocation.count({
            where: { status: "ACTIVE", expectedReturnDate: { gte: now, lte: upcomingWindowEnd }, ...assetRelationWhere },
          }),

      scope.kind === "PERSONAL"
        ? prisma.allocation.count({
            where: { status: "ACTIVE", holderEmployeeId: scope.userId, expectedReturnDate: { lt: now } },
          })
        : prisma.allocation.count({
            where: { status: "ACTIVE", expectedReturnDate: { lt: now }, ...assetRelationWhere },
          }),
    ]);

    return {
      scope: scope.kind,
      kpis: {
        assetsAvailable,
        assetsAllocated,
        maintenanceToday,
        activeBookings,
        pendingTransfers,
        upcomingReturns,
      },
      overdueReturns,
      quickActions: {
        canRegisterAsset: ["ADMIN", "ASSET_MANAGER"].includes(request.user.role),
        canBookResource: true,
        canRaiseMaintenanceRequest: true,
      },
    };
  });

  // ---- Overdue vs. upcoming returns, as actual records (not just counts) ----
  // for the dashboard's return-tracking widget, scoped the same way as /summary.
  app.get("/returns", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const query = returnsQuerySchema.parse(request.query);

    const scopeResult = await resolveScope(request, query.departmentId);
    if (!scopeResult.ok) {
      return reply.code(scopeResult.code ?? 400).send({ error: scopeResult.error });
    }
    const scope = scopeResult.scope;

    const now = new Date();
    const upcomingWindowEnd = new Date(now.getTime() + query.upcomingWindowDays * 24 * 60 * 60 * 1000);

    const baseWhere: any = { status: "ACTIVE" };
    if (scope.kind === "PERSONAL") baseWhere.holderEmployeeId = scope.userId;
    if (scope.kind === "DEPARTMENT") baseWhere.asset = { departmentId: { in: scope.departmentIds } };

    const [overdue, upcoming] = await Promise.all([
      prisma.allocation.findMany({
        where: { ...baseWhere, expectedReturnDate: { lt: now } },
        include: allocationInclude,
        orderBy: { expectedReturnDate: "asc" },
        take: query.limit,
      }),
      prisma.allocation.findMany({
        where: { ...baseWhere, expectedReturnDate: { gte: now, lte: upcomingWindowEnd } },
        include: allocationInclude,
        orderBy: { expectedReturnDate: "asc" },
        take: query.limit,
      }),
    ]);

    return { overdue, upcoming };
  });
}
