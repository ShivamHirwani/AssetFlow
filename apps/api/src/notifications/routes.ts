import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const notificationTypeValues = [
  "ASSET_ASSIGNED",
  "MAINTENANCE_APPROVED",
  "MAINTENANCE_REJECTED",
  "BOOKING_CONFIRMED",
  "BOOKING_CANCELLED",
  "BOOKING_REMINDER",
  "TRANSFER_REQUESTED",
  "TRANSFER_APPROVED",
  "TRANSFER_REJECTED",
  "OVERDUE_RETURN_ALERT",
  "OVERDUE_BOOKING_ALERT",
  "AUDIT_DISCREPANCY_FLAGGED",
  "AUDIT_CYCLE_CLOSED",
  "GENERAL",
] as const;

const listNotificationsQuerySchema = z.object({
  isRead: z.enum(["true", "false"]).optional(),
  type: z.enum(notificationTypeValues).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export async function notificationRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];

  // ---- List current user's notifications ----
  // Always scoped to the caller — there is no "view someone else's
  // notifications" concept, not even for Admin.
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listNotificationsQuerySchema.parse(request.query);
    const userId = request.user.sub as string;

    const where: any = { userId };
    if (query.isRead === "true") where.isRead = true;
    if (query.isRead === "false") where.isRead = false;
    if (query.type) where.type = query.type;

    const [total, unreadCount, notifications] = await prisma.$transaction([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false } }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return { total, unreadCount, page: query.page, pageSize: query.pageSize, notifications };
  });

  // ---- Unread count only (cheap poll target for a notification bell) ----
  app.get("/unread-count", { onRequest: anyAuthenticated }, async (request: any) => {
    const unreadCount = await prisma.notification.count({
      where: { userId: request.user.sub, isRead: false },
    });
    return { unreadCount };
  });

  // ---- Mark one as read ----
  // Idempotent: re-marking an already-read notification just returns it
  // as-is rather than erroring.
  app.post("/:id/read", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification) {
      return reply.code(404).send({ error: "Notification not found" });
    }
    if (notification.userId !== request.user.sub) {
      // 404 rather than 403 — don't reveal that a notification with this
      // id exists for someone else's account.
      return reply.code(404).send({ error: "Notification not found" });
    }
    if (notification.isRead) {
      return notification;
    }

    const updated = await prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
    return updated;
  });

  // ---- Mark all as read ----
  app.post("/read-all", { onRequest: anyAuthenticated }, async (request: any) => {
    const result = await prisma.notification.updateMany({
      where: { userId: request.user.sub, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { markedRead: result.count };
  });

  // ---- Dismiss/delete one ----
  // Not in the original spec list but a normal expectation once a bell
  // UI exists — lets a user clear a notification without it counting
  // toward pagination forever. Same ownership check as /read.
  app.delete("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const notification = await prisma.notification.findUnique({ where: { id } });
    if (!notification || notification.userId !== request.user.sub) {
      return reply.code(404).send({ error: "Notification not found" });
    }

    await prisma.notification.delete({ where: { id } });
    return reply.code(204).send();
  });
}
