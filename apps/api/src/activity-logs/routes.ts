import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const listActivityLogsQuerySchema = z
  .object({
    userId: z.string().cuid().optional(),
    action: z.string().optional(),
    entityType: z.string().optional(),
    entityId: z.string().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: "from must be before or equal to to",
  });

const logInclude = {
  user: { select: { id: true, name: true, email: true, role: true } },
} as const;

export async function activityLogRoutes(app: FastifyInstance) {
  // Org-wide action history — Admin and Asset Manager only. Department
  // Heads/Employees see their own actions implicitly through the screens
  // that show notifications/history for entities they hold; this is the
  // "who did what, when" oversight view, not a personal feed.
  const managerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];

  app.get("/", { onRequest: managerOrAdmin }, async (request: any) => {
    const query = listActivityLogsQuerySchema.parse(request.query);

    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = query.from;
      if (query.to) where.createdAt.lte = query.to;
    }

    const [total, logs] = await prisma.$transaction([
      prisma.activityLog.count({ where }),
      prisma.activityLog.findMany({
        where,
        include: logInclude,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, page: query.page, pageSize: query.pageSize, logs };
  });

  // ---- Distinct action names ----
  // Small convenience endpoint so a filter dropdown doesn't have to
  // hardcode every action string used across the codebase (ASSET_ALLOCATED,
  // TRANSFER_REQUESTED, AUDIT_ITEM_MARKED, etc.) — they aren't a Prisma enum.
  app.get("/actions", { onRequest: managerOrAdmin }, async () => {
    const distinct = await prisma.activityLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    });
    return { actions: distinct.map((d) => d.action) };
  });
}
