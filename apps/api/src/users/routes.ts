import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const PROMOTABLE_ROLES = ["DEPARTMENT_HEAD", "ASSET_MANAGER"] as const;

const promoteSchema = z.object({
  role: z.enum(PROMOTABLE_ROLES),
});

const updateUserSchema = z.object({
  departmentId: z.string().cuid().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  const adminOnly = [app.authenticate, app.requireRole("ADMIN")];

  // Requires a valid JWT — proves the auth guard + Prisma wiring work end to end.
  app.get("/me", { onRequest: [app.authenticate] }, async (request: any, reply) => {
    const userId = request.user.sub as string;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        department: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return user;
  });

  // Employee Directory (Screen 3, Tab C) — Admin only.
app.get("/", { onRequest: [app.authenticate, app.requireRole("ADMIN", "ASSET_MANAGER")] }, async () => {
    return prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        department: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { name: "asc" },
    });
  });

  app.get("/:id", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        department: { select: { id: true, name: true } },
        createdAt: true,
      },
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return user;
  });

  // Edit department assignment / active-inactive status from the directory.
  // Does NOT touch role — that only happens via /promote or /demote below.
  app.patch("/:id", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = updateUserSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (body.departmentId) {
      const department = await prisma.department.findUnique({
        where: { id: body.departmentId },
      });
      if (!department) {
        return reply
          .code(400)
          .send({ error: "departmentId does not reference an existing department" });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        departmentId: body.departmentId === undefined ? undefined : body.departmentId,
        status: body.status,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        department: { select: { id: true, name: true } },
      },
    });

    return updated;
  });

  // This is the ONLY place roles are assigned, per the spec — signup always
  // creates an EMPLOYEE, and self-elevation is never allowed.
  app.post("/:id/promote", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = promoteSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (user.role === body.role) {
      return reply.code(409).send({ error: `User is already ${body.role}` });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: body.role },
      select: { id: true, name: true, email: true, role: true },
    });

    return updated;
  });

  // Revert a Department Head / Asset Manager back to a plain Employee.
  app.post("/:id/demote", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (user.role === "ADMIN") {
      return reply.code(400).send({ error: "Cannot demote an Admin through this endpoint" });
    }

    if (user.role === "EMPLOYEE") {
      return reply.code(409).send({ error: "User is already an Employee" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role: "EMPLOYEE" },
      select: { id: true, name: true, email: true, role: true },
    });

    return updated;
  });
}
