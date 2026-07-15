import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const auditItemStatusValues = ["PENDING", "VERIFIED", "MISSING", "DAMAGED"] as const;

const createAuditCycleSchema = z
  .object({
    name: z.string().min(1),
    scopeDepartmentId: z.string().cuid().nullable().optional(),
    scopeLocation: z.string().min(1).nullable().optional(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    auditorIds: z.array(z.string().cuid()).min(1, "At least one auditor must be assigned"),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "endDate must be after startDate",
  });

const addAuditorsSchema = z.object({
  auditorIds: z.array(z.string().cuid()).min(1),
});

const markAuditItemSchema = z.object({
  status: z.enum(["VERIFIED", "MISSING", "DAMAGED"]),
  discrepancyNote: z.string().optional(),
});

const listAuditCyclesQuerySchema = z.object({
  status: z.enum(["PLANNED", "IN_PROGRESS", "CLOSED"]).optional(),
  scopeDepartmentId: z.string().cuid().optional(),
  auditorId: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const listAuditItemsQuerySchema = z.object({
  status: z.enum(auditItemStatusValues).optional(),
});

const auditCycleListInclude = {
  createdBy: { select: { id: true, name: true } },
  auditors: { include: { auditor: { select: { id: true, name: true, email: true } } } },
  _count: { select: { items: true } },
} as const;

const auditItemInclude = {
  asset: { select: { id: true, assetTag: true, name: true, location: true, status: true } },
  recordedBy: { select: { id: true, name: true } },
} as const;

export async function auditRoutes(app: FastifyInstance) {
  const adminOnly = [app.authenticate, app.requireRole("ADMIN")];
  const assetManagerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];
  const anyAuthenticated = [app.authenticate];

  // ---- Create an audit cycle (Admin only) ----
  // Populates one AuditItem per in-scope asset up front, so the cycle
  // starts life as a concrete checklist rather than an empty shell.
  app.post("/", { onRequest: adminOnly }, async (request: any, reply) => {
    const body = createAuditCycleSchema.parse(request.body);

    const auditors = await prisma.user.findMany({ where: { id: { in: body.auditorIds } } });
    if (auditors.length !== body.auditorIds.length) {
      return reply.code(400).send({ error: "One or more auditorIds do not reference an existing user" });
    }

    if (body.scopeDepartmentId) {
      const department = await prisma.department.findUnique({ where: { id: body.scopeDepartmentId } });
      if (!department) {
        return reply
          .code(400)
          .send({ error: "scopeDepartmentId does not reference an existing department" });
      }
    }

    // No scopeDepartmentId/scopeLocation at all = organization-wide audit.
    const assetWhere: any = { status: { not: "DISPOSED" } };
    if (body.scopeDepartmentId) assetWhere.departmentId = body.scopeDepartmentId;
    if (body.scopeLocation) assetWhere.location = { contains: body.scopeLocation, mode: "insensitive" };

    const scopedAssets = await prisma.asset.findMany({ where: assetWhere, select: { id: true } });
    if (scopedAssets.length === 0) {
      return reply.code(400).send({ error: "No assets match the given scope — nothing to audit" });
    }

    const cycle = await prisma.$transaction(async (tx) => {
      const created = await tx.auditCycle.create({
        data: {
          name: body.name,
          scopeDepartmentId: body.scopeDepartmentId ?? null,
          scopeLocation: body.scopeLocation ?? null,
          startDate: body.startDate,
          endDate: body.endDate,
          createdById: request.user.sub,
        },
      });

      await tx.auditAssignment.createMany({
        data: body.auditorIds.map((auditorId) => ({ auditCycleId: created.id, auditorId })),
        skipDuplicates: true,
      });

      await tx.auditItem.createMany({
        data: scopedAssets.map((a) => ({ auditCycleId: created.id, assetId: a.id })),
      });

      await tx.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "AUDIT_CYCLE_CREATED",
          entityType: "AuditCycle",
          entityId: created.id,
          metadata: { assetCount: scopedAssets.length, auditorCount: body.auditorIds.length },
        },
      });

      for (const auditorId of body.auditorIds) {
        await tx.notification.create({
          data: {
            userId: auditorId,
            type: "GENERAL",
            title: "Assigned as Auditor",
            message: `You've been assigned as an auditor for the "${created.name}" audit cycle covering ${scopedAssets.length} asset(s).`,
            entityType: "AuditCycle",
            entityId: created.id,
          },
        });
      }

      return created;
    });

    return reply.code(201).send({ ...cycle, assetCount: scopedAssets.length });
  });

  // ---- List / filter audit cycles ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listAuditCyclesQuerySchema.parse(request.query);

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.scopeDepartmentId) where.scopeDepartmentId = query.scopeDepartmentId;
    if (query.auditorId) where.auditors = { some: { auditorId: query.auditorId } };

    const [total, auditCycles] = await prisma.$transaction([
      prisma.auditCycle.count({ where }),
      prisma.auditCycle.findMany({
        where,
        include: auditCycleListInclude,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, auditCycles };
  });

  // ---- Get one, with item status breakdown ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const cycle = await prisma.auditCycle.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true } },
        auditors: { include: { auditor: { select: { id: true, name: true, email: true } } } },
      },
    });

    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }

    const statusCounts = await prisma.auditItem.groupBy({
      by: ["status"],
      where: { auditCycleId: id },
      _count: true,
    });

    const itemSummary = { PENDING: 0, VERIFIED: 0, MISSING: 0, DAMAGED: 0 } as Record<string, number>;
    for (const row of statusCounts) {
      itemSummary[row.status] = row._count;
    }

    let scopeDepartment = null;
    if (cycle.scopeDepartmentId) {
      scopeDepartment = await prisma.department.findUnique({
        where: { id: cycle.scopeDepartmentId },
        select: { id: true, name: true },
      });
    }

    return { ...cycle, scopeDepartment, itemSummary };
  });

  // ---- Add auditors to an existing (non-closed) cycle (Admin only) ----
  app.post("/:id/auditors", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = addAuditorsSchema.parse(request.body);

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }
    if (cycle.status === "CLOSED") {
      return reply.code(400).send({ error: "Cannot modify auditors on a closed audit cycle" });
    }

    const auditors = await prisma.user.findMany({ where: { id: { in: body.auditorIds } } });
    if (auditors.length !== body.auditorIds.length) {
      return reply.code(400).send({ error: "One or more auditorIds do not reference an existing user" });
    }

    await prisma.$transaction([
      prisma.auditAssignment.createMany({
        data: body.auditorIds.map((auditorId) => ({ auditCycleId: id, auditorId })),
        skipDuplicates: true,
      }),
      ...body.auditorIds.map((auditorId) =>
        prisma.notification.create({
          data: {
            userId: auditorId,
            type: "GENERAL",
            title: "Assigned as Auditor",
            message: `You've been assigned as an auditor for the "${cycle.name}" audit cycle.`,
            entityType: "AuditCycle",
            entityId: id,
          },
        })
      ),
    ]);

    return prisma.auditAssignment.findMany({
      where: { auditCycleId: id },
      include: { auditor: { select: { id: true, name: true, email: true } } },
    });
  });

  // ---- Remove an auditor from a cycle (Admin only) ----
  app.delete("/:id/auditors/:auditorId", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id, auditorId } = request.params as { id: string; auditorId: string };

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }
    if (cycle.status === "CLOSED") {
      return reply.code(400).send({ error: "Cannot modify auditors on a closed audit cycle" });
    }

    const assignment = await prisma.auditAssignment.findUnique({
      where: { auditCycleId_auditorId: { auditCycleId: id, auditorId } },
    });
    if (!assignment) {
      return reply.code(404).send({ error: "This user is not assigned as an auditor on this cycle" });
    }

    await prisma.auditAssignment.delete({ where: { id: assignment.id } });
    return reply.code(204).send();
  });

  // ---- List items in a cycle (the auditor's checklist) ----
  app.get("/:id/items", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const query = listAuditItemsQuerySchema.parse(request.query);

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }

    const where: any = { auditCycleId: id };
    if (query.status) where.status = query.status;

    return prisma.auditItem.findMany({
      where,
      include: auditItemInclude,
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
  });

  // ---- Auto-generated discrepancy report (Missing / Damaged items) ----
  app.get("/:id/discrepancies", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }

    return prisma.auditItem.findMany({
      where: { auditCycleId: id, status: { in: ["MISSING", "DAMAGED"] } },
      include: auditItemInclude,
      orderBy: { recordedAt: "desc" },
    });
  });

  // ---- Auditor marks a single asset: Verified / Missing / Damaged ----
  app.post("/:id/items/:itemId/mark", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = markAuditItemSchema.parse(request.body);

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }
    if (cycle.status === "CLOSED") {
      return reply.code(400).send({ error: "This audit cycle is closed and can no longer be edited" });
    }

    const item = await prisma.auditItem.findUnique({
      where: { id: itemId },
      include: { asset: { select: { id: true, assetTag: true, name: true } } },
    });
    if (!item || item.auditCycleId !== id) {
      return reply.code(404).send({ error: "Audit item not found on this cycle" });
    }

    let authorized = ["ADMIN", "ASSET_MANAGER"].includes(request.user.role);
    if (!authorized) {
      const assignment = await prisma.auditAssignment.findUnique({
        where: { auditCycleId_auditorId: { auditCycleId: id, auditorId: request.user.sub } },
      });
      authorized = !!assignment;
    }
    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you are not an auditor on this cycle" });
    }

    const ops: any[] = [
      prisma.auditItem.update({
        where: { id: itemId },
        data: {
          status: body.status,
          discrepancyNote: body.discrepancyNote,
          recordedById: request.user.sub,
          recordedAt: new Date(),
        },
        include: auditItemInclude,
      }),
    ];

    // First mark on a PLANNED cycle flips it to IN_PROGRESS automatically.
    if (cycle.status === "PLANNED") {
      ops.push(prisma.auditCycle.update({ where: { id }, data: { status: "IN_PROGRESS" } }));
    }

    ops.push(
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "AUDIT_ITEM_MARKED",
          entityType: "AuditItem",
          entityId: itemId,
          metadata: { auditCycleId: id, assetId: item.assetId, status: body.status },
        },
      })
    );

    if (body.status === "MISSING" || body.status === "DAMAGED") {
      const managers = await prisma.user.findMany({
        where: { role: { in: ["ADMIN", "ASSET_MANAGER"] } },
        select: { id: true },
      });
      for (const manager of managers) {
        ops.push(
          prisma.notification.create({
            data: {
              userId: manager.id,
              type: "AUDIT_DISCREPANCY_FLAGGED",
              title: "Audit Discrepancy Flagged",
              message: `${item.asset.name} (${item.asset.assetTag}) was marked ${body.status} during the "${cycle.name}" audit.`,
              entityType: "AuditItem",
              entityId: itemId,
            },
          })
        );
      }
    }

    const [updatedItem] = await prisma.$transaction(ops);
    return updatedItem;
  });

  // ---- Close the cycle: locks it, applies status/condition updates for flagged items ----
  app.post("/:id/close", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const cycle = await prisma.auditCycle.findUnique({ where: { id } });
    if (!cycle) {
      return reply.code(404).send({ error: "Audit cycle not found" });
    }
    if (cycle.status === "CLOSED") {
      return reply.code(400).send({ error: "This audit cycle is already closed" });
    }

    const pendingCount = await prisma.auditItem.count({
      where: { auditCycleId: id, status: "PENDING" },
    });
    if (pendingCount > 0) {
      return reply.code(400).send({
        error: `Cannot close — ${pendingCount} asset(s) have not yet been verified`,
      });
    }

    const missingItems = await prisma.auditItem.findMany({
      where: { auditCycleId: id, status: "MISSING" },
      select: { assetId: true },
    });
    const damagedItems = await prisma.auditItem.findMany({
      where: { auditCycleId: id, status: "DAMAGED" },
      select: { assetId: true },
    });

    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.auditCycle.update({
        where: { id },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      // Confirmed-missing assets flip to LOST — skip anything already
      // RETIRED/DISPOSED so we don't resurrect a decommissioned asset.
      if (missingItems.length > 0) {
        await tx.asset.updateMany({
          where: {
            id: { in: missingItems.map((i) => i.assetId) },
            status: { notIn: ["RETIRED", "DISPOSED"] },
          },
          data: { status: "LOST" },
        });
      }

      // Confirmed-damaged assets get their condition updated. Status is
      // deliberately left alone — raising a maintenance request is a
      // separate, explicit action rather than an automatic side effect.
      if (damagedItems.length > 0) {
        await tx.asset.updateMany({
          where: { id: { in: damagedItems.map((i) => i.assetId) } },
          data: { condition: "DAMAGED" },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "AUDIT_CYCLE_CLOSED",
          entityType: "AuditCycle",
          entityId: id,
          metadata: { missingCount: missingItems.length, damagedCount: damagedItems.length },
        },
      });

      const auditors = await tx.auditAssignment.findMany({ where: { auditCycleId: id } });
      for (const a of auditors) {
        await tx.notification.create({
          data: {
            userId: a.auditorId,
            type: "AUDIT_CYCLE_CLOSED",
            title: "Audit Cycle Closed",
            message: `The "${cycle.name}" audit cycle has been closed.`,
            entityType: "AuditCycle",
            entityId: id,
          },
        });
      }

      await tx.notification.create({
        data: {
          userId: cycle.createdById,
          type: "AUDIT_CYCLE_CLOSED",
          title: "Audit Cycle Closed",
          message: `The "${cycle.name}" audit cycle you created has been closed — ${missingItems.length} missing, ${damagedItems.length} damaged.`,
          entityType: "AuditCycle",
          entityId: id,
        },
      });

      return closed;
    });

    return result;
  });
}
