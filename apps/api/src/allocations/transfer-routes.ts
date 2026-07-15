import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";
import { validateHolder, resolveHolderDepartmentId, holderIncludeSelect } from "./holder-utils";

const createTransferRequestSchema = z
  .object({
    assetId: z.string().cuid(),
    toHolderType: z.enum(["EMPLOYEE", "DEPARTMENT"]),
    toHolderEmployeeId: z.string().cuid().optional(),
    toHolderDepartmentId: z.string().cuid().optional(),
    reason: z.string().optional(),
  })
  .refine(
    (data) =>
      data.toHolderType === "EMPLOYEE"
        ? !!data.toHolderEmployeeId && !data.toHolderDepartmentId
        : !!data.toHolderDepartmentId && !data.toHolderEmployeeId,
    {
      message:
        "Provide toHolderEmployeeId for an EMPLOYEE target or toHolderDepartmentId for a DEPARTMENT target (not both)",
    }
  );

const transferDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  decisionNotes: z.string().optional(),
});

const listTransferRequestsQuerySchema = z.object({
  assetId: z.string().cuid().optional(),
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "COMPLETED"]).optional(),
  requestedById: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const transferIncludeForDecision = {
  asset: true,
  fromAllocation: true,
} as const;

export async function transferRequestRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];

  // ---- Raise a transfer request ----
  app.post("/", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const body = createTransferRequestSchema.parse(request.body);

    // Employees can only request the asset for themselves; Department
    // Heads only for themselves or their own department. Asset
    // Manager/Admin can raise a transfer request targeting anyone
    // (administrative reallocation planning).
    if (request.user.role === "EMPLOYEE") {
      if (body.toHolderType !== "EMPLOYEE" || body.toHolderEmployeeId !== request.user.sub) {
        return reply
          .code(403)
          .send({ error: "Employees may only request a transfer of the asset to themselves" });
      }
    } else if (request.user.role === "DEPARTMENT_HEAD") {
      const isSelf = body.toHolderType === "EMPLOYEE" && body.toHolderEmployeeId === request.user.sub;
      let isOwnDepartment = false;
      if (body.toHolderType === "DEPARTMENT" && body.toHolderDepartmentId) {
        const dept = await prisma.department.findUnique({ where: { id: body.toHolderDepartmentId } });
        isOwnDepartment = dept?.headId === request.user.sub;
      }
      if (!isSelf && !isOwnDepartment) {
        return reply.code(403).send({
          error: "Department Heads may only request transfers to themselves or their own department",
        });
      }
    }

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) {
      return reply.code(400).send({ error: "assetId does not reference an existing asset" });
    }

    const activeAllocation = await prisma.allocation.findFirst({
      where: { assetId: body.assetId, status: "ACTIVE" },
    });
    if (!activeAllocation) {
      return reply.code(400).send({
        error:
          "Asset is not currently allocated — use POST /allocations to allocate it directly instead of requesting a transfer",
      });
    }

    const alreadyHeldByTarget =
      activeAllocation.holderType === body.toHolderType &&
      (body.toHolderType === "EMPLOYEE"
        ? activeAllocation.holderEmployeeId === body.toHolderEmployeeId
        : activeAllocation.holderDepartmentId === body.toHolderDepartmentId);
    if (alreadyHeldByTarget) {
      return reply.code(400).send({ error: "Asset is already held by this holder" });
    }

    const holderCheck = await validateHolder(
      body.toHolderType,
      body.toHolderEmployeeId,
      body.toHolderDepartmentId
    );
    if (!holderCheck.ok) {
      return reply.code(400).send({ error: holderCheck.error });
    }

    const ops: any[] = [
      prisma.transferRequest.create({
        data: {
          assetId: body.assetId,
          fromAllocationId: activeAllocation.id,
          toHolderType: body.toHolderType,
          toHolderEmployeeId: body.toHolderType === "EMPLOYEE" ? body.toHolderEmployeeId : null,
          toHolderDepartmentId: body.toHolderType === "DEPARTMENT" ? body.toHolderDepartmentId : null,
          requestedById: request.user.sub,
          reason: body.reason,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "TRANSFER_REQUESTED",
          entityType: "Asset",
          entityId: body.assetId,
          metadata: { toHolderType: body.toHolderType },
        },
      }),
    ];

    // Let the current holder know someone wants their asset.
    if (activeAllocation.holderType === "EMPLOYEE" && activeAllocation.holderEmployeeId) {
      ops.push(
        prisma.notification.create({
          data: {
            userId: activeAllocation.holderEmployeeId,
            type: "TRANSFER_REQUESTED",
            title: "Transfer Requested",
            message: `${asset.name} (${asset.assetTag}), currently allocated to you, has a pending transfer request.`,
            entityType: "Asset",
            entityId: asset.id,
          },
        })
      );
    }

    const [transferRequest] = await prisma.$transaction(ops);
    return reply.code(201).send(transferRequest);
  });

  // ---- List / filter transfer requests ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listTransferRequestsQuerySchema.parse(request.query);

    const where: any = {};
    if (query.assetId) where.assetId = query.assetId;
    if (query.status) where.status = query.status;
    if (query.requestedById) where.requestedById = query.requestedById;

    const [total, transferRequests] = await prisma.$transaction([
      prisma.transferRequest.count({ where }),
      prisma.transferRequest.findMany({
        where,
        include: {
          asset: { select: { id: true, assetTag: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          decidedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, transferRequests };
  });

  // ---- Get one ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const transferRequest = await prisma.transferRequest.findUnique({
      where: { id },
      include: {
        asset: { select: { id: true, assetTag: true, name: true, status: true } },
        fromAllocation: { include: holderIncludeSelect },
        requestedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });

    if (!transferRequest) {
      return reply.code(404).send({ error: "Transfer request not found" });
    }

    return transferRequest;
  });

  // ---- Approve / reject ----
  app.post("/:id/decision", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = transferDecisionSchema.parse(request.body);

    const transferRequest = await prisma.transferRequest.findUnique({
      where: { id },
      include: transferIncludeForDecision,
    });
    if (!transferRequest) {
      return reply.code(404).send({ error: "Transfer request not found" });
    }
    if (transferRequest.status !== "REQUESTED") {
      return reply.code(400).send({ error: "This transfer request has already been decided" });
    }

    let authorized = ["ADMIN", "ASSET_MANAGER"].includes(request.user.role);

    if (!authorized && request.user.role === "DEPARTMENT_HEAD") {
      const fromDeptId = transferRequest.fromAllocation
        ? await resolveHolderDepartmentId(
            transferRequest.fromAllocation.holderType,
            transferRequest.fromAllocation.holderEmployeeId,
            transferRequest.fromAllocation.holderDepartmentId
          )
        : null;
      const toDeptId = await resolveHolderDepartmentId(
        transferRequest.toHolderType,
        transferRequest.toHolderEmployeeId,
        transferRequest.toHolderDepartmentId
      );
      const relevantDeptIds = [fromDeptId, toDeptId].filter((v): v is string => !!v);
      if (relevantDeptIds.length > 0) {
        const headedDepartment = await prisma.department.findFirst({
          where: { id: { in: relevantDeptIds }, headId: request.user.sub },
        });
        authorized = !!headedDepartment;
      }
    }

    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot decide this transfer request" });
    }

    if (body.decision === "REJECT") {
      const updated = await prisma.$transaction([
        prisma.transferRequest.update({
          where: { id },
          data: {
            status: "REJECTED",
            decidedById: request.user.sub,
            decidedAt: new Date(),
            decisionNotes: body.decisionNotes,
          },
        }),
        prisma.notification.create({
          data: {
            userId: transferRequest.requestedById,
            type: "TRANSFER_REJECTED",
            title: "Transfer Rejected",
            message: `Your transfer request for ${transferRequest.asset.name} (${transferRequest.asset.assetTag}) was rejected.`,
            entityType: "Asset",
            entityId: transferRequest.assetId,
          },
        }),
        prisma.activityLog.create({
          data: {
            userId: request.user.sub,
            action: "TRANSFER_REJECTED",
            entityType: "Asset",
            entityId: transferRequest.assetId,
            metadata: { transferRequestId: id, decisionNotes: body.decisionNotes ?? null },
          },
        }),
      ]);
      return updated[0];
    }

    // APPROVE — atomically return the old allocation and re-allocate to
    // the requested holder in one interactive transaction.
    const result = await prisma.$transaction(async (tx) => {
      if (transferRequest.fromAllocationId) {
        await tx.allocation.update({
          where: { id: transferRequest.fromAllocationId },
          data: {
            status: "RETURNED",
            actualReturnDate: new Date(),
            returnedById: request.user.sub,
          },
        });
      }

      const newAllocation = await tx.allocation.create({
        data: {
          assetId: transferRequest.assetId,
          holderType: transferRequest.toHolderType,
          holderEmployeeId: transferRequest.toHolderEmployeeId,
          holderDepartmentId: transferRequest.toHolderDepartmentId,
          allocatedById: request.user.sub,
        },
      });

      const updatedTransferRequest = await tx.transferRequest.update({
        where: { id },
        data: {
          status: "COMPLETED",
          decidedById: request.user.sub,
          decidedAt: new Date(),
          decisionNotes: body.decisionNotes,
        },
      });

      await tx.notification.create({
        data: {
          userId: transferRequest.requestedById,
          type: "TRANSFER_APPROVED",
          title: "Transfer Approved",
          message: `Your transfer request for ${transferRequest.asset.name} (${transferRequest.asset.assetTag}) was approved.`,
          entityType: "Asset",
          entityId: transferRequest.assetId,
        },
      });

      if (transferRequest.toHolderType === "EMPLOYEE" && transferRequest.toHolderEmployeeId) {
        await tx.notification.create({
          data: {
            userId: transferRequest.toHolderEmployeeId,
            type: "ASSET_ASSIGNED",
            title: "Asset Assigned",
            message: `${transferRequest.asset.name} (${transferRequest.asset.assetTag}) has been transferred to you.`,
            entityType: "Asset",
            entityId: transferRequest.assetId,
          },
        });
      }

      await tx.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "TRANSFER_APPROVED",
          entityType: "Asset",
          entityId: transferRequest.assetId,
          metadata: { transferRequestId: id, newAllocationId: newAllocation.id },
        },
      });

      return { transferRequest: updatedTransferRequest, newAllocation };
    });

    return result;
  });
}
