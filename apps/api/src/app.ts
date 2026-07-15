import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import { env } from "./common/env";
import { authRoutes } from "./auth/routes";
import { userRoutes } from "./users/routes";
import { departmentRoutes } from "./departments/routes";
import { assetCategoryRoutes } from "./assets/category-routes";
import { assetRoutes } from "./assets/routes";
import { allocationRoutes } from "./allocations/routes";
import { transferRequestRoutes } from "./allocations/transfer-routes";
import { bookingRoutes } from "./bookings/routes";
import { maintenanceRoutes } from "./maintenance/routes";
import { auditRoutes } from "./audits/routes";
import { dashboardRoutes } from "./dashboard/routes";
import { notificationRoutes } from "./notifications/routes";
import { activityLogRoutes } from "./activity-logs/routes";
import { reportRoutes } from "./reports/routes";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  // Simple auth guard other routes can use via { onRequest: [app.authenticate] }
  app.decorate("authenticate", async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // Role guard — usage: { onRequest: [app.authenticate, app.requireRole("ADMIN")] }
  app.decorate("requireRole", (...allowedRoles: string[]) => {
    return async (request: any, reply: any) => {
      const role = request.user?.role;
      if (!role || !allowedRoles.includes(role)) {
        reply.code(403).send({ error: "Forbidden — insufficient role" });
      }
    };
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(departmentRoutes, { prefix: "/departments" });
  await app.register(assetCategoryRoutes, { prefix: "/asset-categories" });
  await app.register(assetRoutes, { prefix: "/assets" });
  await app.register(allocationRoutes, { prefix: "/allocations" });
  await app.register(transferRequestRoutes, { prefix: "/transfer-requests" });
  await app.register(bookingRoutes, { prefix: "/bookings" });
  await app.register(maintenanceRoutes, { prefix: "/maintenance-requests" });
  await app.register(auditRoutes, { prefix: "/audits" });
  await app.register(dashboardRoutes, { prefix: "/dashboard" });
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(activityLogRoutes, { prefix: "/activity-logs" });
  await app.register(reportRoutes, { prefix: "/reports" });

  return app;
}
