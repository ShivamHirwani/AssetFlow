import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const createDepartmentSchema = z.object({
  name: z.string().min(1),
  headId: z.string().cuid().nullable().optional(),
  parentDepartmentId: z.string().cuid().nullable().optional(),
});

const updateDepartmentSchema = z.object({
  name: z.string().min(1).optional(),
  headId: z.string().cuid().nullable().optional(),
  parentDepartmentId: z.string().cuid().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

/**
 * Walks up the parent chain starting from `candidateParentId` to make sure
 * `departmentId` never appears — i.e. prevents A -> B -> A style cycles
 * when (re)assigning a parent department.
 */
async function wouldCreateCycle(
  departmentId: string,
  candidateParentId: string
): Promise<boolean> {
  let currentId: string | null = candidateParentId;

  while (currentId) {
    if (currentId === departmentId) return true;

    const current: { parentDepartmentId: string | null } | null =
      await prisma.department.findUnique({
        where: { id: currentId },
        select: { parentDepartmentId: true },
      });

    currentId = current?.parentDepartmentId ?? null;
  }

  return false;
}

export async function departmentRoutes(app: FastifyInstance) {
  const adminOnly = [app.authenticate, app.requireRole("ADMIN")];

  // List — any authenticated user can view departments (needed for dropdowns
  // across allocation, booking, employee directory, etc.)
  app.get("/", { onRequest: [app.authenticate] }, async () => {
    return prisma.department.findMany({
      include: {
        head: { select: { id: true, name: true, email: true } },
        parentDepartment: { select: { id: true, name: true } },
        _count: { select: { employees: true, assets: true } },
      },
      orderBy: { name: "asc" },
    });
  });

  app.get("/:id", { onRequest: [app.authenticate] }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const department = await prisma.department.findUnique({
      where: { id },
      include: {
        head: { select: { id: true, name: true, email: true } },
        parentDepartment: { select: { id: true, name: true } },
        childDepartments: { select: { id: true, name: true } },
        employees: { select: { id: true, name: true, email: true, role: true } },
      },
    });

    if (!department) {
      return reply.code(404).send({ error: "Department not found" });
    }

    return department;
  });

  app.post("/", { onRequest: adminOnly }, async (request: any, reply) => {
    const body = createDepartmentSchema.parse(request.body);

    const existing = await prisma.department.findUnique({ where: { name: body.name } });
    if (existing) {
      return reply.code(409).send({ error: "A department with this name already exists" });
    }

    if (body.headId) {
      const head = await prisma.user.findUnique({ where: { id: body.headId } });
      if (!head) {
        return reply.code(400).send({ error: "headId does not reference an existing user" });
      }
    }

    if (body.parentDepartmentId) {
      const parent = await prisma.department.findUnique({
        where: { id: body.parentDepartmentId },
      });
      if (!parent) {
        return reply
          .code(400)
          .send({ error: "parentDepartmentId does not reference an existing department" });
      }
    }

    const department = await prisma.department.create({
      data: {
        name: body.name,
        headId: body.headId ?? null,
        parentDepartmentId: body.parentDepartmentId ?? null,
      },
    });

    return reply.code(201).send(department);
  });

  app.patch("/:id", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = updateDepartmentSchema.parse(request.body);

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      return reply.code(404).send({ error: "Department not found" });
    }

    if (body.name && body.name !== department.name) {
      const nameTaken = await prisma.department.findUnique({ where: { name: body.name } });
      if (nameTaken) {
        return reply.code(409).send({ error: "A department with this name already exists" });
      }
    }

    if (body.headId) {
      const head = await prisma.user.findUnique({ where: { id: body.headId } });
      if (!head) {
        return reply.code(400).send({ error: "headId does not reference an existing user" });
      }
    }

    if (body.parentDepartmentId) {
      if (body.parentDepartmentId === id) {
        return reply.code(400).send({ error: "A department cannot be its own parent" });
      }

      const parent = await prisma.department.findUnique({
        where: { id: body.parentDepartmentId },
      });
      if (!parent) {
        return reply
          .code(400)
          .send({ error: "parentDepartmentId does not reference an existing department" });
      }

      if (await wouldCreateCycle(id, body.parentDepartmentId)) {
        return reply
          .code(400)
          .send({ error: "This parent assignment would create a department hierarchy cycle" });
      }
    }

    const updated = await prisma.department.update({
      where: { id },
      data: {
        name: body.name,
        headId: body.headId === undefined ? undefined : body.headId,
        parentDepartmentId:
          body.parentDepartmentId === undefined ? undefined : body.parentDepartmentId,
        status: body.status,
      },
    });

    return updated;
  });

  // Deactivate is just a status transition, not a hard delete — asset/employee
  // history referencing this department must remain intact.
  app.post("/:id/deactivate", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      return reply.code(404).send({ error: "Department not found" });
    }

    const updated = await prisma.department.update({
      where: { id },
      data: { status: "INACTIVE" },
    });

    return updated;
  });

  app.post("/:id/activate", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) {
      return reply.code(404).send({ error: "Department not found" });
    }

    const updated = await prisma.department.update({
      where: { id },
      data: { status: "ACTIVE" },
    });

    return updated;
  });
}
