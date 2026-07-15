import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@assetflow/db";

const customFieldDefSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "number", "date", "boolean"]),
});

const createCategorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  customFields: z.array(customFieldDefSchema).optional(),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  customFields: z.array(customFieldDefSchema).nullable().optional(),
});

export async function assetCategoryRoutes(app: FastifyInstance) {
  const adminOnly = [app.authenticate, app.requireRole("ADMIN")];

  // Any authenticated user needs to read categories (asset registration form,
  // search filters, etc.)
  app.get("/", { onRequest: [app.authenticate] }, async () => {
    return prisma.assetCategory.findMany({
      include: { _count: { select: { assets: true } } },
      orderBy: { name: "asc" },
    });
  });

  app.get("/:id", { onRequest: [app.authenticate] }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const category = await prisma.assetCategory.findUnique({
      where: { id },
      include: { _count: { select: { assets: true } } },
    });

    if (!category) {
      return reply.code(404).send({ error: "Asset category not found" });
    }

    return category;
  });

  app.post("/", { onRequest: adminOnly }, async (request: any, reply) => {
    const body = createCategorySchema.parse(request.body);

    const existing = await prisma.assetCategory.findUnique({ where: { name: body.name } });
    if (existing) {
      return reply.code(409).send({ error: "A category with this name already exists" });
    }

    const category = await prisma.assetCategory.create({
      data: {
        name: body.name,
        description: body.description,
        customFields: body.customFields ?? undefined,
      },
    });

    return reply.code(201).send(category);
  });

  app.patch("/:id", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const body = updateCategorySchema.parse(request.body);

    const category = await prisma.assetCategory.findUnique({ where: { id } });
    if (!category) {
      return reply.code(404).send({ error: "Asset category not found" });
    }

    if (body.name && body.name !== category.name) {
      const nameTaken = await prisma.assetCategory.findUnique({ where: { name: body.name } });
      if (nameTaken) {
        return reply.code(409).send({ error: "A category with this name already exists" });
      }
    }

    const updated = await prisma.assetCategory.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description === undefined ? undefined : body.description,
        customFields: body.customFields === undefined ? undefined : body.customFields,
      },
    });

    return updated;
  });

  // No hard delete — categories are referenced by assets and shouldn't
  // disappear out from under existing inventory records.
  app.delete("/:id", { onRequest: adminOnly }, async (request: any, reply) => {
    const { id } = request.params as { id: string };

    const category = await prisma.assetCategory.findUnique({
      where: { id },
      include: { _count: { select: { assets: true } } },
    });

    if (!category) {
      return reply.code(404).send({ error: "Asset category not found" });
    }

    if (category._count.assets > 0) {
      return reply.code(409).send({
        error: `Cannot delete — ${category._count.assets} asset(s) still reference this category`,
      });
    }

    await prisma.assetCategory.delete({ where: { id } });
    return reply.code(204).send();
  });
}
