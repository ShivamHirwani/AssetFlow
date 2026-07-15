import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";
import { validateHolder, holderIncludeSelect } from "./holder-utils";

const assetConditionValues = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"] as const;

const createAllocationSchema = z
  .object({
    assetId: z.string().cuid(),
    holderType: z.enum(["EMPLOYEE", "DEPARTMENT"]),
    holderEmployeeId: z.string().cuid().optional(),
    holderDepartmentId: z.string().cuid().optional(),
    expectedReturnDate: z.coerce.date().optional(),
  })
  .refine(
    (data) =>
      data.holderType === "EMPLOYEE"
        ? !!data.holderEmployeeId && !data.holderDepartmentId
        : !!data.holderDepartmentId && !data.holderEmployeeId,
    {
      message:
        "Provide holderEmployeeId for an EMPLOYEE holder or holderDepartmentId for a DEPARTMENT holder (not both)",
    }
  );

const returnAllocationSchema = z.object({
  checkInCondition: z.enum(assetConditionValues).optional(),
  checkInNotes: z.string().optional(),
});

const listAllocationsQuerySchema = z.object({
  assetId: z.string().cuid().optional(),
  holderEmployeeId: z.string().cuid().optional(),
  holderDepartmentId: z.string().cuid().optional(),
  status: z.enum(["ACTIVE", "RETURNED", "CANCELLED"]).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function allocationRoutes(app: FastifyInstance) {
  const assetManagerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];
  const anyAuthenticated = [app.authenticate];

  // ---- Allocate an asset to an employee/department ----
  app.post("/", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const body = createAllocationSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) {
      return reply.code(400).send({ error: "assetId does not reference an existing asset" });
    }

    if (asset.status !== "AVAILABLE") {
      if (asset.status === "ALLOCATED") {
        const activeAllocation = await prisma.allocation.findFirst({
          where: { assetId: asset.id, status: "ACTIVE" },
          include: holderIncludeSelect,
        });
        return reply.code(409).send({
          error: "Asset is already allocated",
          currentHolder:
            activeAllocation?.holderType === "EMPLOYEE"
              ? activeAllocation.holderEmployee
              : activeAllocation?.holderDepartment,
          suggestion: "This asset is taken — use POST /transfer-requests to request a transfer instead",
        });
      }
      return reply
        .code(409)
        .send({ error: `Asset is not available for allocation (current status: ${asset.status})` });
    }

    const holderCheck = await validateHolder(
      body.holderType,
      body.holderEmployeeId,
      body.holderDepartmentId
    );
    if (!holderCheck.ok) {
      return reply.code(400).send({ error: holderCheck.error });
    }

    const ops: any[] = [
      prisma.allocation.create({
        data: {
          assetId: body.assetId,
          holderType: body.holderType,
          holderEmployeeId: body.holderType === "EMPLOYEE" ? body.holderEmployeeId : null,
          holderDepartmentId: body.holderType === "DEPARTMENT" ? body.holderDepartmentId : null,
          allocatedById: request.user.sub,
          expectedReturnDate: body.expectedReturnDate,
        },
        include: holderIncludeSelect,
      }),
      prisma.asset.update({ where: { id: body.assetId }, data: { status: "ALLOCATED" } }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "ASSET_ALLOCATED",
          entityType: "Asset",
          entityId: asset.id,
          metadata: {
            holderType: body.holderType,
            holderEmployeeId: body.holderEmployeeId ?? null,
            holderDepartmentId: body.holderDepartmentId ?? null,
          },
        },
      }),
    ];

    if (body.holderType === "EMPLOYEE" && body.holderEmployeeId) {
      ops.push(
        prisma.notification.create({
          data: {
            userId: body.holderEmployeeId,
            type: "ASSET_ASSIGNED",
            title: "Asset Assigned",
            message: `${asset.name} (${asset.assetTag}) has been assigned to you.`,
            entityType: "Asset",
            entityId: asset.id,
          },
        })
      );
    }

    const [allocation] = await prisma.$transaction(ops);
    return reply.code(201).send(allocation);
  });

  // ---- List / filter allocations ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listAllocationsQuerySchema.parse(request.query);

    const where: any = {};
    if (query.assetId) where.assetId = query.assetId;
    if (query.holderEmployeeId) where.holderEmployeeId = query.holderEmployeeId;
    if (query.holderDepartmentId) where.holderDepartmentId = query.holderDepartmentId;
    if (query.status) where.status = query.status;
    if (query.overdue === "true") {
      where.status = "ACTIVE";
      where.expectedReturnDate = { lt: new Date() };
    }

    const [total, allocations] = await prisma.$transaction([
      prisma.allocation.count({ where }),
      prisma.allocation.findMany({
        where,
        include: {
          asset: { select: { id: true, assetTag: true, name: true } },
          ...holderIncludeSelect,
          allocatedBy: { select: { id: true, name: true } },
        },
        orderBy: { allocatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, allocations };
  });

  // ---- Overdue allocations (feeds Dashboard + Notifications) ----
  app.get("/overdue", { onRequest: anyAuthenticated }, async () => {
    return prisma.allocation.findMany({
      where: { status: "ACTIVE", expectedReturnDate: { lt: new Date() } },
      include: {
        asset: { select: { id: true, assetTag: true, name: true } },
        ...holderIncludeSelect,
      },
      orderBy: { expectedReturnDate: "asc" },
    });
  });

  // ---- Get one ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const allocation = await prisma.allocation.findUnique({
      where: { id },
      include: {
        asset: { select: { id: true, assetTag: true, name: true, status: true } },
        ...holderIncludeSelect,
        allocatedBy: { select: { id: true, name: true } },
        returnedBy: { select: { id: true, name: true } },
        transferRequests: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!allocation) {
      return reply.code(404).send({ error: "Allocation not found" });
    }

    return allocation;
  });

  // ---- Return flow ----
  // Allowed for Asset Manager/Admin, the holder themselves (Employee
  // "initiates" a return), or the head of the holding department. The
  // schema has no separate pending-return state, so this is the single
  // action that finalizes it — whoever calls it is asserting the asset
  // has physically come back.
  app.post("/:id/return", { onRequest: [app.authenticate] }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = returnAllocationSchema.parse(request.body ?? {});

    const allocation = await prisma.allocation.findUnique({ where: { id } });
    if (!allocation) {
      return reply.code(404).send({ error: "Allocation not found" });
    }
    if (allocation.status !== "ACTIVE") {
      return reply.code(400).send({ error: "Allocation is not active" });
    }

    let authorized = ["ADMIN", "ASSET_MANAGER"].includes(request.user.role);

    if (!authorized && allocation.holderType === "EMPLOYEE") {
      authorized = allocation.holderEmployeeId === request.user.sub;
    }

    if (!authorized && allocation.holderType === "DEPARTMENT" && allocation.holderDepartmentId) {
      const department = await prisma.department.findUnique({
        where: { id: allocation.holderDepartmentId },
      });
      authorized = department?.headId === request.user.sub;
    }

    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot return this allocation" });
    }

    const [updated] = await prisma.$transaction([
      prisma.allocation.update({
        where: { id },
        data: {
          status: "RETURNED",
          actualReturnDate: new Date(),
          checkInNotes: body.checkInNotes,
          checkInCondition: body.checkInCondition,
          returnedById: request.user.sub,
        },
      }),
      prisma.asset.update({
        where: { id: allocation.assetId },
        data: {
          status: "AVAILABLE",
          condition: body.checkInCondition ?? undefined,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "ALLOCATION_RETURNED",
          entityType: "Asset",
          entityId: allocation.assetId,
          metadata: { allocationId: id, checkInCondition: body.checkInCondition ?? null },
        },
      }),
    ]);

    return updated;
  });
}
