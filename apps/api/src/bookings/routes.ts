import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const createBookingSchema = z
  .object({
    assetId: z.string().cuid(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    purpose: z.string().optional(),
    onBehalfOfDepartmentId: z.string().cuid().optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "endTime must be after startTime",
  })
  .refine((data) => data.startTime > new Date(Date.now() - 60_000), {
    message: "startTime cannot be in the past",
  });

const rescheduleBookingSchema = z
  .object({
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    purpose: z.string().optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: "endTime must be after startTime",
  });

const cancelBookingSchema = z.object({
  cancelReason: z.string().optional(),
});

const listBookingsQuerySchema = z.object({
  assetId: z.string().cuid().optional(),
  requestedById: z.string().cuid().optional(),
  onBehalfOfDepartmentId: z.string().cuid().optional(),
  status: z.enum(["UPCOMING", "ONGOING", "COMPLETED", "CANCELLED"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const NON_BOOKABLE_STATUSES = ["LOST", "RETIRED", "DISPOSED", "UNDER_MAINTENANCE"] as const;

const bookingInclude = {
  asset: { select: { id: true, assetTag: true, name: true, location: true } },
  requestedBy: { select: { id: true, name: true, email: true } },
  onBehalfOfDepartment: { select: { id: true, name: true } },
} as const;

/**
 * Booking.status is only ever persisted as UPCOMING or CANCELLED (there's
 * no cron in this build to flip rows over time). ONGOING/COMPLETED are
 * derived from startTime/endTime at read time, the same way overdue
 * allocations are computed via a query filter rather than a stored flag.
 */
function withComputedStatus<T extends { status: string; cancelledAt: Date | null; startTime: Date; endTime: Date }>(
  booking: T,
  now: Date = new Date()
): T {
  if (booking.status === "CANCELLED" || booking.cancelledAt) {
    return { ...booking, status: "CANCELLED" };
  }
  if (now >= booking.endTime) {
    return { ...booking, status: "COMPLETED" };
  }
  if (now >= booking.startTime) {
    return { ...booking, status: "ONGOING" };
  }
  return { ...booking, status: "UPCOMING" };
}

class BookingOverlapError extends Error {
  constructor(public conflicting: { id: string; startTime: Date; endTime: Date }) {
    super("Booking overlaps an existing booking for this asset");
  }
}

/**
 * Checks who is allowed to act (create/cancel/reschedule) on behalf of
 * `onBehalfOfDepartmentId`. Mirrors the transfer-request scoping: Admin
 * and Asset Manager are unrestricted, a Department Head may only act for
 * their own department, everyone else may only book for themselves (no
 * onBehalfOfDepartmentId at all).
 */
async function assertCanActOnBehalfOf(
  role: string,
  userId: string,
  onBehalfOfDepartmentId: string | null | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!onBehalfOfDepartmentId) return { ok: true };

  if (["ADMIN", "ASSET_MANAGER"].includes(role)) return { ok: true };

  if (role === "DEPARTMENT_HEAD") {
    const department = await prisma.department.findUnique({
      where: { id: onBehalfOfDepartmentId },
    });
    if (!department) {
      return { ok: false, error: "onBehalfOfDepartmentId does not reference an existing department" };
    }
    if (department.headId !== userId) {
      return { ok: false, error: "You may only book on behalf of your own department" };
    }
    return { ok: true };
  }

  return { ok: false, error: "Only a Department Head may book on behalf of a department" };
}

export async function bookingRoutes(app: FastifyInstance) {
  const anyAuthenticated = [app.authenticate];
  const assetManagerOrAdmin = [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")];

  // ---- Create a booking ----
  app.post("/", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const body = createBookingSchema.parse(request.body);

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) {
      return reply.code(400).send({ error: "assetId does not reference an existing asset" });
    }
    if (!asset.isBookable) {
      return reply.code(400).send({ error: "This asset is not marked as a bookable resource" });
    }
    if (NON_BOOKABLE_STATUSES.includes(asset.status as (typeof NON_BOOKABLE_STATUSES)[number])) {
      return reply
        .code(409)
        .send({ error: `Asset cannot be booked while its status is ${asset.status}` });
    }

    const scopeCheck = await assertCanActOnBehalfOf(
      request.user.role,
      request.user.sub,
      body.onBehalfOfDepartmentId
    );
    if (!scopeCheck.ok) {
      return reply.code(403).send({ error: scopeCheck.error });
    }

    try {
      const booking = await prisma.$transaction(async (tx) => {
        // Serialize booking creation per-asset so two concurrent requests
        // for overlapping slots can't both pass the overlap check before
        // either has inserted its row.
        await tx.$queryRaw`SELECT id FROM assets WHERE id = ${body.assetId} FOR UPDATE`;

        const overlapping = await tx.booking.findFirst({
          where: {
            assetId: body.assetId,
            cancelledAt: null,
            status: { not: "CANCELLED" },
            startTime: { lt: body.endTime },
            endTime: { gt: body.startTime },
          },
        });

        if (overlapping) {
          throw new BookingOverlapError(overlapping);
        }

        const created = await tx.booking.create({
          data: {
            assetId: body.assetId,
            requestedById: request.user.sub,
            onBehalfOfDepartmentId: body.onBehalfOfDepartmentId ?? null,
            startTime: body.startTime,
            endTime: body.endTime,
            purpose: body.purpose,
          },
          include: bookingInclude,
        });

        await tx.notification.create({
          data: {
            userId: request.user.sub,
            type: "BOOKING_CONFIRMED",
            title: "Booking Confirmed",
            message: `${asset.name} (${asset.assetTag}) is booked for you from ${body.startTime.toISOString()} to ${body.endTime.toISOString()}.`,
            entityType: "Booking",
            entityId: created.id,
          },
        });

        await tx.activityLog.create({
          data: {
            userId: request.user.sub,
            action: "BOOKING_CREATED",
            entityType: "Booking",
            entityId: created.id,
            metadata: { assetId: body.assetId, startTime: body.startTime, endTime: body.endTime },
          },
        });

        return created;
      });

      return reply.code(201).send(withComputedStatus(booking));
    } catch (err) {
      if (err instanceof BookingOverlapError) {
        return reply.code(409).send({
          error: "This time slot overlaps an existing booking for this asset",
          conflictingBooking: err.conflicting,
        });
      }
      throw err;
    }
  });

  // ---- List / filter bookings (also serves the per-resource calendar view via ?assetId=) ----
  app.get("/", { onRequest: anyAuthenticated }, async (request: any) => {
    const query = listBookingsQuerySchema.parse(request.query);

    const where: any = {};
    if (query.assetId) where.assetId = query.assetId;
    if (query.requestedById) where.requestedById = query.requestedById;
    if (query.onBehalfOfDepartmentId) where.onBehalfOfDepartmentId = query.onBehalfOfDepartmentId;
    if (query.from || query.to) {
      where.startTime = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }
    // CANCELLED is a real stored status; UPCOMING/ONGOING/COMPLETED are
    // derived, so filtering by those happens after the fetch below.
    if (query.status === "CANCELLED") where.status = "CANCELLED";
    if (query.status && query.status !== "CANCELLED") where.status = { not: "CANCELLED" };

    const [total, rows] = await prisma.$transaction([
      prisma.booking.count({ where }),
      prisma.booking.findMany({
        where,
        include: bookingInclude,
        orderBy: { startTime: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    let bookings = rows.map((b) => withComputedStatus(b));
    if (query.status && query.status !== "CANCELLED") {
      bookings = bookings.filter((b) => b.status === query.status);
    }

    return { total, page: query.page, pageSize: query.pageSize, bookings };
  });

  // ---- Get one ----
  app.get("/:id", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const booking = await prisma.booking.findUnique({
      where: { id },
      include: bookingInclude,
    });

    if (!booking) {
      return reply.code(404).send({ error: "Booking not found" });
    }

    return withComputedStatus(booking);
  });

  // ---- Cancel ----
  app.post("/:id/cancel", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = cancelBookingSchema.parse(request.body ?? {});

    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) {
      return reply.code(404).send({ error: "Booking not found" });
    }
    if (booking.status === "CANCELLED" || booking.cancelledAt) {
      return reply.code(400).send({ error: "Booking is already cancelled" });
    }
    if (booking.endTime <= new Date()) {
      return reply.code(400).send({ error: "Cannot cancel a booking that has already ended" });
    }

    let authorized = ["ADMIN", "ASSET_MANAGER"].includes(request.user.role);
    authorized = authorized || booking.requestedById === request.user.sub;

    if (!authorized && booking.onBehalfOfDepartmentId) {
      const department = await prisma.department.findUnique({
        where: { id: booking.onBehalfOfDepartmentId },
      });
      authorized = department?.headId === request.user.sub;
    }

    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot cancel this booking" });
    }

    const [updated] = await prisma.$transaction([
      prisma.booking.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelReason: body.cancelReason,
        },
        include: bookingInclude,
      }),
      prisma.notification.create({
        data: {
          userId: booking.requestedById,
          type: "BOOKING_CANCELLED",
          title: "Booking Cancelled",
          message: `Your booking for ${new Date(booking.startTime).toISOString()} has been cancelled.`,
          entityType: "Booking",
          entityId: booking.id,
        },
      }),
      prisma.activityLog.create({
        data: {
          userId: request.user.sub,
          action: "BOOKING_CANCELLED",
          entityType: "Booking",
          entityId: booking.id,
          metadata: { cancelReason: body.cancelReason ?? null },
        },
      }),
    ]);

    return withComputedStatus(updated);
  });

  // ---- Reschedule (cancel old + create new, same convention as transfer requests) ----
  app.post("/:id/reschedule", { onRequest: anyAuthenticated }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = rescheduleBookingSchema.parse(request.body);

    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) {
      return reply.code(404).send({ error: "Booking not found" });
    }
    if (existing.status === "CANCELLED" || existing.cancelledAt) {
      return reply.code(400).send({ error: "Cannot reschedule a cancelled booking" });
    }
    if (existing.endTime <= new Date()) {
      return reply.code(400).send({ error: "Cannot reschedule a booking that has already ended" });
    }

    let authorized = ["ADMIN", "ASSET_MANAGER"].includes(request.user.role);
    authorized = authorized || existing.requestedById === request.user.sub;

    if (!authorized && existing.onBehalfOfDepartmentId) {
      const department = await prisma.department.findUnique({
        where: { id: existing.onBehalfOfDepartmentId },
      });
      authorized = department?.headId === request.user.sub;
    }

    if (!authorized) {
      return reply.code(403).send({ error: "Forbidden — you cannot reschedule this booking" });
    }

    const asset = await prisma.asset.findUnique({ where: { id: existing.assetId } });
    if (!asset) {
      return reply.code(400).send({ error: "Underlying asset no longer exists" });
    }
    if (NON_BOOKABLE_STATUSES.includes(asset.status as (typeof NON_BOOKABLE_STATUSES)[number])) {
      return reply
        .code(409)
        .send({ error: `Asset cannot be booked while its status is ${asset.status}` });
    }

    try {
      const newBooking = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM assets WHERE id = ${existing.assetId} FOR UPDATE`;

        const overlapping = await tx.booking.findFirst({
          where: {
            id: { not: existing.id },
            assetId: existing.assetId,
            cancelledAt: null,
            status: { not: "CANCELLED" },
            startTime: { lt: body.endTime },
            endTime: { gt: body.startTime },
          },
        });
        if (overlapping) {
          throw new BookingOverlapError(overlapping);
        }

        await tx.booking.update({
          where: { id: existing.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelReason: "Rescheduled",
          },
        });

        const created = await tx.booking.create({
          data: {
            assetId: existing.assetId,
            requestedById: existing.requestedById,
            onBehalfOfDepartmentId: existing.onBehalfOfDepartmentId,
            startTime: body.startTime,
            endTime: body.endTime,
            purpose: body.purpose ?? existing.purpose,
          },
          include: bookingInclude,
        });

        await tx.notification.create({
          data: {
            userId: existing.requestedById,
            type: "BOOKING_CONFIRMED",
            title: "Booking Rescheduled",
            message: `${asset.name} (${asset.assetTag}) has been rescheduled to ${body.startTime.toISOString()}.`,
            entityType: "Booking",
            entityId: created.id,
          },
        });

        await tx.activityLog.create({
          data: {
            userId: request.user.sub,
            action: "BOOKING_RESCHEDULED",
            entityType: "Booking",
            entityId: created.id,
            metadata: { previousBookingId: existing.id },
          },
        });

        return created;
      });

      return withComputedStatus(newBooking);
    } catch (err) {
      if (err instanceof BookingOverlapError) {
        return reply.code(409).send({
          error: "The new time slot overlaps an existing booking for this asset",
          conflictingBooking: err.conflicting,
        });
      }
      throw err;
    }
  });

  // ---- Manually trigger reminder notifications ----
  // No scheduler exists in this build; this lets a cron job (or a manual
  // call during a demo) fire BOOKING_REMINDER notifications for bookings
  // starting within the next `withinMinutes` that haven't been reminded yet.
  app.post("/send-reminders", { onRequest: assetManagerOrAdmin }, async (request: any) => {
    const { withinMinutes = 30 } = (request.body ?? {}) as { withinMinutes?: number };
    const now = new Date();
    const windowEnd = new Date(now.getTime() + withinMinutes * 60_000);

    const due = await prisma.booking.findMany({
      where: {
        status: "UPCOMING",
        cancelledAt: null,
        reminderSentAt: null,
        startTime: { gte: now, lte: windowEnd },
      },
      include: { asset: { select: { name: true, assetTag: true } } },
    });

    for (const booking of due) {
      await prisma.$transaction([
        prisma.notification.create({
          data: {
            userId: booking.requestedById,
            type: "BOOKING_REMINDER",
            title: "Upcoming Booking Reminder",
            message: `${booking.asset.name} (${booking.asset.assetTag}) is booked for you starting at ${booking.startTime.toISOString()}.`,
            entityType: "Booking",
            entityId: booking.id,
          },
        }),
        prisma.booking.update({
          where: { id: booking.id },
          data: { reminderSentAt: new Date() },
        }),
      ]);
    }

    return { remindersSent: due.length };
  });
}
