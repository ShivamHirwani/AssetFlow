import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const priorityValues = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const attachmentInputSchema = z.object({
  url: z.string().url(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

const createMaintenanceRequestSchema = z.object({
  assetId: z.string().cuid(),
  issueDescription: z.string().min(1),
  priority: z.enum(priorityValues).default("MEDIUM"),
  attachments: z.array(attachmentInputSchema).optional(),
});

const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  decisionNotes: z.string().optional(),
});

const assignTechnicianSchema = z
  .object({
    technicianId: z.string().cuid().optional(),
    technicianName: z.string().optional(),
  })
  .refine((data) => !!data.technicianId || !!data.technicianName, {
    message: "Provide either technicianId (system user) or technicianName (external technician)",
  });

const resolveSchema = z.object({
  resolutionNotes: z.string().optional(),
});

const listMaintenanceQuerySchema = z.object({
  assetId: z.string().cuid().optional(),
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED", "TECHNICIAN_ASSIGNED", "IN_PROGRESS", "RESOLVED"])
    .optional(),
  priority: z.enum(priorityValues).optional(),
  raisedById: z.string().cuid().optional(),
  technicianId: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// Requests already "open" against an asset — blocks raising a duplicate
// request for the same asset while one is already being worked.
const OPEN_STATUSES = ["PENDING", "APPROVED", "TECHNICIAN_ASSIGNED", "IN_PROGRESS"] as const;
const NOT_SERVICEABLE_STATUSES = ["LOST", "RETIRED", "DISPOSED"] as const;

const maintenanceInclude = {
  asset: { select: { id: true, assetTag: true, name: true, status: true } },
  raisedBy: { select: { id: true, name: true, email: true } },
  decidedBy: { select: { id: true, name: true } },
  technician: { select: { id: true, name: true, email: true } },
} as const;

async function attachmentsFor(maintenanceRequestId: string) {
  return prisma.attachment.findMany({
    where: { ownerType: "MAINTENANCE_REQUEST", ownerId: maintenanceRequestId },
    orderBy: { createdAt: "asc" },
  });
}

export async function maintenanceRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];
  const assetManagerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];

  // ---- Raise a maintenance request ----
  app.post("/", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const body = createMaintenanceRequestSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) {
      return reply.code(400).send({ error: "assetId does not reference an existing asset" });
    }
    if (NOT_SERVICEABLE_STATUSES.includes(asset.status as (typeof NOT_SERVICEABLE_STATUSES)[number])) {
      return reply
        .code(409)
        .send({ error: `Cannot raise a maintenance request for an asset with status ${asset.status}` });
    }

    const openRequest = await prisma.maintenanceRequest.findFirst({
      where: { assetId: body.assetId, status: { in: [...OPEN_STATUSES] } },
    });
    if (openRequest) {
      return reply.code(409).send({
        error: "An open maintenance request already exists for this asset",
        existingRequestId: openRequest.id,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const maintenanceRequest = await tx.maintenanceRequest.create({
        data: {
          assetId: body.assetId,
          raisedById: request.user.sub,
          issueDescription: body.issueDescription,
          priority: body.priority,
        },
        include: maintenanceInclude,
      });

      if (body.attachments?.length) {
        await tx.attachment.createMany({
          data: body.attachments.map((a) => ({
            url: a.url,
            fileName: a.fileName,
            mimeType: a.mimeType,
            ownerType: "MAINTENANCE_REQUEST",
            ownerId: maintenanceRequest.id,
          })),
        });
      }

      await tx.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "MAINTENANCE_REQUESTED",
          entityType: "MaintenanceRequest",
          entityId: maintenanceRequest.id,
          metadata: { assetId: body.assetId, priority: body.priority },
        },
      });

      return maintenanceRequest;
    });

    const attachments = await attachmentsFor(created.id);
    return reply.code(201).send({ ...created, attachments });
  });

  // ---- List / filter ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listMaintenanceQuerySchema.parse(request.query);

    const where: any = {};
    if (query.assetId) where.assetId = query.assetId;
    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.raisedById) where.raisedById = query.raisedById;
    if (query.technicianId) where.technicianId = query.technicianId;

    const [total, maintenanceRequests] = await prisma.$transaction([
      prisma.maintenanceRequest.count({ where }),
      prisma.maintenanceRequest.findMany({
        where,
        include: maintenanceInclude,
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, maintenanceRequests };
  });

  // ---- Get one ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const maintenanceRequest = await prisma.maintenanceRequest.findUnique({
      where: { id },
      include: maintenanceInclude,
    });

    if (!maintenanceRequest) {
      return reply.code(404).send({ error: "Maintenance request not found" });
    }

    const attachments = await attachmentsFor(id);
    return { ...maintenanceRequest, attachments };
  });

  // ---- Approve / reject (Asset Manager / Admin only) ----
  // On approve: asset flips to UNDER_MAINTENANCE. On reject: asset is
  // left untouched — it never left AVAILABLE/whatever it already was.
  app.post("/:id/decision", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = decisionSchema.parse(request.body);

    const maintenanceRequest = await prisma.maintenanceRequest.findUnique({
      where: { id },
      include: { asset: true },
    });
    if (!maintenanceRequest) {
      return reply.code(404).send({ error: "Maintenance request not found" });
    }
    if (maintenanceRequest.status !== "PENDING") {
      return reply.code(400).send({ error: "This maintenance request has already been decided" });
    }

    if (body.decision === "REJECT") {
      const [updated] = await prisma.$transaction([
        prisma.maintenanceRequest.update({
          where: { id },
          data: {
            status: "REJECTED",
            decidedById: request.user.sub,
            decidedAt: new Date(),
            decisionNotes: body.decisionNotes,
          },
          include: maintenanceInclude,
        }),
        prisma.notification.create({
          data: {
            userId: maintenanceRequest.raisedById,
            type: "MAINTENANCE_REJECTED",
            title: "Maintenance Request Rejected",
            message: `Your maintenance request for ${maintenanceRequest.asset.name} (${maintenanceRequest.asset.assetTag}) was rejected.`,
            entityType: "MaintenanceRequest",
            entityId: id,
          },
        }),
        prisma.activityLog.create({
          data: {
            userId: request.user.sub,
            action: "MAINTENANCE_REJECTED",
            entityType: "MaintenanceRequest",
            entityId: id,
            metadata: { decisionNotes: body.decisionNotes ?? null },
          },
        }),
      ]);
      const attachments = await attachmentsFor(id);
      return { ...updated, attachments };
    }

    // APPROVE
    const [updated] = await prisma.$transaction([
      prisma.maintenanceRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          decidedById: request.user.sub,
          decidedAt: new Date(),
          decisionNotes: body.decisionNotes,
        },
        include: maintenanceInclude,
      }),
      prisma.asset.update({
        where: { id: maintenanceRequest.assetId },
        data: { status: "UNDER_MAINTENANCE" },
      }),
      prisma.notification.create({
        data: {
          userId: maintenanceRequest.raisedById,
          type: "MAINTENANCE_APPROVED",
          title: "Maintenance Request Approved",
          message: `Your maintenance request for ${maintenanceRequest.asset.name} (${maintenanceRequest.asset.assetTag}) was approved.`,
          entityType: "MaintenanceRequest",
          entityId: id,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "MAINTENANCE_APPROVED",
          entityType: "MaintenanceRequest",
          entityId: id,
          metadata: { decisionNotes: body.decisionNotes ?? null },
        },
      }),
    ]);

    const attachments = await attachmentsFor(id);
    return { ...updated, attachments };
  });

  // ---- Assign technician (Asset Manager / Admin only) ----
  app.post("/:id/assign-technician", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = assignTechnicianSchema.parse(request.body);

    const maintenanceRequest = await prisma.maintenanceRequest.findUnique({
      where: { id },
      include: { asset: true },
    });
    if (!maintenanceRequest) {
      return reply.code(404).send({ error: "Maintenance request not found" });
    }
    if (maintenanceRequest.status !== "APPROVED") {
      return reply
        .code(400)
        .send({ error: "A technician can only be assigned to an APPROVED maintenance request" });
    }

    if (body.technicianId) {
      const technician = await prisma.user.findUnique({ where: { id: body.technicianId } });
      if (!technician) {
        return reply.code(400).send({ error: "technicianId does not reference an existing user" });
      }
    }

    const [updated] = await prisma.$transaction([
      prisma.maintenanceRequest.update({
        where: { id },
        data: {
          status: "TECHNICIAN_ASSIGNED",
          technicianId: body.technicianId ?? null,
          technicianName: body.technicianName ?? null,
          assignedAt: new Date(),
        },
        include: maintenanceInclude,
      }),
      prisma.notification.create({
        data: {
          userId: maintenanceRequest.raisedById,
          type: "GENERAL",
          title: "Technician Assigned",
          message: `A technician has been assigned to your maintenance request for ${maintenanceRequest.asset.name} (${maintenanceRequest.asset.assetTag}).`,
          entityType: "MaintenanceRequest",
          entityId: id,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "MAINTENANCE_TECHNICIAN_ASSIGNED",
          entityType: "MaintenanceRequest",
          entityId: id,
          metadata: { technicianId: body.technicianId ?? null, technicianName: body.technicianName ?? null },
        },
      }),
    ]);

    if (body.technicianId) {
      await prisma.notification.create({
        data: {
          userId: body.technicianId,
          type: "GENERAL",
          title: "New Assignment",
          message: `You've been assigned to repair ${maintenanceRequest.asset.name} (${maintenanceRequest.asset.assetTag}).`,
          entityType: "MaintenanceRequest",
          entityId: id,
        },
      });
    }

    const attachments = await attachmentsFor(id);
    return { ...updated, attachments };
  });

  // ---- Start work (Asset Manager/Admin, or the assigned technician) ----
  app.post("/:id/start", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const maintenanceRequest = await prisma.maintenanceRequest.findUnique({ where: { id } });
    if (!maintenanceRequest) {
      return reply.code(404).send({ error: "Maintenance request not found" });
    }
    if (maintenanceRequest.status !== "TECHNICIAN_ASSIGNED") {
      return reply
        .code(400)
        .send({ error: "Work can only start once a technician has been assigned" });
    }

    const authorized =
      ["ADMIN", "ASSET_MANAGER"].includes(request.user.role) ||
      maintenanceRequest.technicianId === request.user.sub;
    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot start work on this request" });
    }

    const [updated] = await prisma.$transaction([
      prisma.maintenanceRequest.update({
        where: { id },
        data: { status: "IN_PROGRESS" },
        include: maintenanceInclude,
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "MAINTENANCE_IN_PROGRESS",
          entityType: "MaintenanceRequest",
          entityId: id,
        },
      }),
    ]);

    const attachments = await attachmentsFor(id);
    return { ...updated, attachments };
  });

  // ---- Resolve (Asset Manager/Admin, or the assigned technician) ----
  // Asset flips back to AVAILABLE per the problem statement.
  app.post("/:id/resolve", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = resolveSchema.parse(request.body ?? {});

    const maintenanceRequest = await prisma.maintenanceRequest.findUnique({
      where: { id },
      include: { asset: true },
    });
    if (!maintenanceRequest) {
      return reply.code(404).send({ error: "Maintenance request not found" });
    }
    if (maintenanceRequest.status !== "IN_PROGRESS") {
      return reply.code(400).send({ error: "Only an IN_PROGRESS request can be resolved" });
    }

    const authorized =
      ["ADMIN", "ASSET_MANAGER"].includes(request.user.role) ||
      maintenanceRequest.technicianId === request.user.sub;
    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot resolve this request" });
    }

    const [updated] = await prisma.$transaction([
      prisma.maintenanceRequest.update({
        where: { id },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolutionNotes: body.resolutionNotes,
        },
        include: maintenanceInclude,
      }),
      prisma.asset.update({
        where: { id: maintenanceRequest.assetId },
        data: { status: "AVAILABLE" },
      }),
      prisma.notification.create({
        data: {
          userId: maintenanceRequest.raisedById,
          type: "GENERAL",
          title: "Maintenance Resolved",
          message: `${maintenanceRequest.asset.name} (${maintenanceRequest.asset.assetTag}) has been repaired and is available again.`,
          entityType: "MaintenanceRequest",
          entityId: id,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "MAINTENANCE_RESOLVED",
          entityType: "MaintenanceRequest",
          entityId: id,
          metadata: { resolutionNotes: body.resolutionNotes ?? null },
        },
      }),
    ]);

    const attachments = await attachmentsFor(id);
    return { ...updated, attachments };
  });
}
