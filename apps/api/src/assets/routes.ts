import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const assetConditionValues = ["NEW", "GOOD", "FAIR", "POOR", "DAMAGED"] as const;
const assetStatusValues = [
  "AVAILABLE",
  "ALLOCATED",
  "RESERVED",
  "UNDER_MAINTENANCE",
  "LOST",
  "RETIRED",
  "DISPOSED",
] as const;

const attachmentInputSchema = z.object({
  url: z.string().url(),
  fileName: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
});

const createAssetSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().cuid(),
  departmentId: z.string().cuid().nullable().optional(),
  serialNumber: z.string().min(1).nullable().optional(),
  qrCode: z.string().min(1).nullable().optional(),
  acquisitionDate: z.coerce.date().optional(),
  acquisitionCost: z.coerce.number().nonnegative().optional(),
  condition: z.enum(assetConditionValues).optional(),
  location: z.string().min(1).optional(),
  isBookable: z.boolean().optional(),
  customFieldValues: z.record(z.any()).optional(),
  // Files are assumed to already be hosted (S3 / local disk / etc.) —
  // this just records pointers via the generic Attachment model. Wire up
  // @fastify/multipart separately if actual upload handling is needed.
  attachments: z.array(attachmentInputSchema).optional(),
});

const updateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  categoryId: z.string().cuid().optional(),
  departmentId: z.string().cuid().nullable().optional(),
  serialNumber: z.string().min(1).nullable().optional(),
  qrCode: z.string().min(1).nullable().optional(),
  acquisitionDate: z.coerce.date().nullable().optional(),
  acquisitionCost: z.coerce.number().nonnegative().nullable().optional(),
  condition: z.enum(assetConditionValues).optional(),
  location: z.string().min(1).nullable().optional(),
  isBookable: z.boolean().optional(),
  customFieldValues: z.record(z.any()).nullable().optional(),
});

const changeStatusSchema = z.object({
  status: z.enum(assetStatusValues),
  reason: z.string().optional(),
});

const listQuerySchema = z.object({
  search: z.string().optional(), // matches assetTag / serialNumber / qrCode / name
  categoryId: z.string().cuid().optional(),
  departmentId: z.string().cuid().optional(),
  status: z.enum(assetStatusValues).optional(),
  location: z.string().optional(),
  isBookable: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Manual/admin status overrides available from the Asset Directory itself.
 * The automatic transitions driven by Allocation (-> ALLOCATED, and back to
 * AVAILABLE on return), Booking (-> RESERVED / -> AVAILABLE), and
 * Maintenance (-> UNDER_MAINTENANCE on approval, -> AVAILABLE on resolution)
 * belong in those modules once they exist. This map only covers the direct
 * overrides an Asset Manager/Admin needs today: flagging something Lost,
 * Retiring/Disposing it, or manually toggling Maintenance.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  AVAILABLE: ["UNDER_MAINTENANCE", "LOST", "RETIRED"],
  ALLOCATED: ["LOST"],
  RESERVED: ["AVAILABLE"],
  UNDER_MAINTENANCE: ["AVAILABLE", "LOST", "RETIRED"],
  LOST: ["AVAILABLE"],
  RETIRED: ["DISPOSED", "AVAILABLE"],
  DISPOSED: [],
};

/**
 * Derives the next AF-#### tag from the highest numeric suffix currently
 * in use. Not race-proof on its own (two concurrent registrations could
 * compute the same next number) — the caller retries on a unique
 * constraint violation, which covers that window.
 */
async function generateNextAssetTag(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("assetTag" FROM 4) AS INTEGER)) as max
    FROM assets
    WHERE "assetTag" ~ '^AF-[0-9]+$'
  `;
  const next = Number(rows[0]?.max ?? 0) + 1;
  return `AF-${String(next).padStart(4, "0")}`;
}

export async function assetRoutes(app: FastifyInstance) {
  const assetManagerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];
  const anyAuthenticated = [app.authenticate];

  // ---- List / search / filter ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listQuerySchema.parse(request.query);

    const where: any = {};
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.departmentId) where.departmentId = query.departmentId;
    if (query.status) where.status = query.status;
    if (query.location) where.location = { contains: query.location, mode: "insensitive" };
    if (query.isBookable !== undefined) where.isBookable = query.isBookable === "true";
    if (query.search) {
      where.OR = [
        { assetTag: { contains: query.search, mode: "insensitive" } },
        { serialNumber: { contains: query.search, mode: "insensitive" } },
        { qrCode: { contains: query.search, mode: "insensitive" } },
        { name: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [total, assets] = await prisma.$transaction([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
          registeredBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, assets };
  });

  // ---- Get one, including current holder (if allocated) ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const asset = await prisma.asset.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true, customFields: true } },
        department: { select: { id: true, name: true } },
        registeredBy: { select: { id: true, name: true, email: true } },
        allocations: {
          where: { status: "ACTIVE" },
          take: 1,
          include: {
            holderEmployee: { select: { id: true, name: true, email: true } },
            holderDepartment: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    const attachments = await prisma.attachment.findMany({
      where: { ownerType: "ASSET", ownerId: id },
      orderBy: { createdAt: "desc" },
    });

    return { ...asset, attachments };
  });

  // ---- Register a new asset ----
  app.post("/", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const body = createAssetSchema.parse(request.body);

    const category = await prisma.assetCategory.findUnique({ where: { id: body.categoryId } });
    if (!category) {
      return reply.code(400).send({ error: "categoryId does not reference an existing category" });
    }

    if (body.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: body.departmentId } });
      if (!department) {
        return reply
          .code(400)
          .send({ error: "departmentId does not reference an existing department" });
      }
    }

    if (body.serialNumber) {
      const existingSerial = await prisma.asset.findUnique({
        where: { serialNumber: body.serialNumber },
      });
      if (existingSerial) {
        return reply.code(409).send({ error: "An asset with this serial number already exists" });
      }
    }

    if (body.qrCode) {
      const existingQr = await prisma.asset.findUnique({ where: { qrCode: body.qrCode } });
      if (existingQr) {
        return reply.code(409).send({ error: "An asset with this QR code already exists" });
      }
    }

    let asset = null;
    for (let attempt = 0; attempt < 5 && !asset; attempt++) {
      const assetTag = await generateNextAssetTag();
      try {
        asset = await prisma.asset.create({
          data: {
            assetTag,
            name: body.name,
            categoryId: body.categoryId,
            departmentId: body.departmentId ?? null,
            serialNumber: body.serialNumber ?? null,
            qrCode: body.qrCode ?? null,
            acquisitionDate: body.acquisitionDate,
            acquisitionCost: body.acquisitionCost,
            condition: body.condition ?? "GOOD",
            location: body.location,
            isBookable: body.isBookable ?? false,
            customFieldValues: body.customFieldValues ?? undefined,
            registeredById: request.user.sub,
          },
        });
      } catch (err: any) {
        // Unique constraint on assetTag — a concurrent registration grabbed
        // the same number first. Loop around and try the next one.
        if (err?.code === "P2002" && err?.meta?.target?.includes?.("assetTag")) {
          continue;
        }
        throw err;
      }
    }

    if (!asset) {
      return reply
        .code(500)
        .send({ error: "Could not generate a unique asset tag — please retry" });
    }

    if (body.attachments?.length) {
      await prisma.attachment.createMany({
        data: body.attachments.map((a) => ({
          url: a.url,
          fileName: a.fileName,
          mimeType: a.mimeType,
          ownerType: "ASSET" as const,
          ownerId: asset!.id,
        })),
      });
    }

    await prisma.activityLog.create({
      data: {
        userId: request.user.sub,
        action: "ASSET_REGISTERED",
        entityType: "Asset",
        entityId: asset.id,
        metadata: { assetTag: asset.assetTag },
      },
    });

    return reply.code(201).send(asset);
  });

  // ---- Edit asset details (not status — see /:id/status) ----
  app.patch("/:id", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = updateAssetSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    if (body.categoryId) {
      const category = await prisma.assetCategory.findUnique({ where: { id: body.categoryId } });
      if (!category) {
        return reply
          .code(400)
          .send({ error: "categoryId does not reference an existing category" });
      }
    }

    if (body.departmentId) {
      const department = await prisma.department.findUnique({ where: { id: body.departmentId } });
      if (!department) {
        return reply
          .code(400)
          .send({ error: "departmentId does not reference an existing department" });
      }
    }

    if (body.serialNumber && body.serialNumber !== asset.serialNumber) {
      const existingSerial = await prisma.asset.findUnique({
        where: { serialNumber: body.serialNumber },
      });
      if (existingSerial) {
        return reply.code(409).send({ error: "An asset with this serial number already exists" });
      }
    }

    if (body.qrCode && body.qrCode !== asset.qrCode) {
      const existingQr = await prisma.asset.findUnique({ where: { qrCode: body.qrCode } });
      if (existingQr) {
        return reply.code(409).send({ error: "An asset with this QR code already exists" });
      }
    }

    const updated = await prisma.asset.update({
      where: { id },
      data: {
        name: body.name,
        categoryId: body.categoryId,
        departmentId: body.departmentId === undefined ? undefined : body.departmentId,
        serialNumber: body.serialNumber === undefined ? undefined : body.serialNumber,
        qrCode: body.qrCode === undefined ? undefined : body.qrCode,
        acquisitionDate: body.acquisitionDate === undefined ? undefined : body.acquisitionDate,
        acquisitionCost: body.acquisitionCost === undefined ? undefined : body.acquisitionCost,
        condition: body.condition,
        location: body.location === undefined ? undefined : body.location,
        isBookable: body.isBookable,
        customFieldValues:
          body.customFieldValues === undefined ? undefined : body.customFieldValues,
      },
    });

    return updated;
  });

  // ---- Manual status transition (Lost / Retired / Disposed / manual Maintenance toggle) ----
  app.post("/:id/status", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = changeStatusSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    if (asset.status === body.status) {
      return reply.code(400).send({ error: `Asset is already ${body.status}` });
    }

    const allowed = ALLOWED_STATUS_TRANSITIONS[asset.status] ?? [];
    if (!allowed.includes(body.status)) {
      return reply.code(400).send({
        error: `Cannot transition asset from ${asset.status} to ${body.status}`,
      });
    }

    const updated = await prisma.asset.update({
      where: { id },
      data: { status: body.status },
    });

    await prisma.activityLog.create({
      data: {
        userId: request.user.sub,
        action: "ASSET_STATUS_CHANGED",
        entityType: "Asset",
        entityId: id,
        metadata: { from: asset.status, to: body.status, reason: body.reason ?? null },
      },
    });

    return updated;
  });

  // ---- Attachments (photos/documents) ----
  app.post("/:id/attachments", { onRequest: assetManagerOrAdmin }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = attachmentInputSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    const attachment = await prisma.attachment.create({
      data: {
        url: body.url,
        fileName: body.fileName,
        mimeType: body.mimeType,
        ownerType: "ASSET",
        ownerId: id,
      },
    });

    return reply.code(201).send(attachment);
  });

  app.get("/:id/attachments", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    return prisma.attachment.findMany({
      where: { ownerType: "ASSET", ownerId: id },
      orderBy: { createdAt: "desc" },
    });
  });

  // ---- Per-asset history: allocations ----
  app.get("/:id/allocations", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    return prisma.allocation.findMany({
      where: { assetId: id },
      include: {
        holderEmployee: { select: { id: true, name: true, email: true } },
        holderDepartment: { select: { id: true, name: true } },
        allocatedBy: { select: { id: true, name: true } },
        returnedBy: { select: { id: true, name: true } },
      },
      orderBy: { allocatedAt: "desc" },
    });
  });

  // ---- Per-asset history: maintenance ----
  app.get("/:id/maintenance", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const asset = await prisma.asset.findUnique({ where: { id } });
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    return prisma.maintenanceRequest.findMany({
      where: { assetId: id },
      include: {
        raisedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
        technician: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });
}
