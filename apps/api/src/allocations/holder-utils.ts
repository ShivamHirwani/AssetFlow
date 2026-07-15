import { prisma } from "@assetflow/db";

type HolderType = "EMPLOYEE" | "DEPARTMENT";

/**
 * Confirms a holderEmployeeId/holderDepartmentId pair (used by both
 * Allocation and TransferRequest) actually points at a real, active
 * user/department before we let anything reference it.
 */
export async function validateHolder(
  holderType: HolderType,
  holderEmployeeId?: string | null,
  holderDepartmentId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (holderType === "EMPLOYEE") {
    if (!holderEmployeeId) {
      return { ok: false, error: "holderEmployeeId is required when holderType is EMPLOYEE" };
    }
    const user = await prisma.user.findUnique({ where: { id: holderEmployeeId } });
    if (!user) {
      return { ok: false, error: "holderEmployeeId does not reference an existing user" };
    }
    if (user.status !== "ACTIVE") {
      return { ok: false, error: "Cannot allocate to an inactive employee" };
    }
    return { ok: true };
  }

  if (!holderDepartmentId) {
    return { ok: false, error: "holderDepartmentId is required when holderType is DEPARTMENT" };
  }
  const department = await prisma.department.findUnique({ where: { id: holderDepartmentId } });
  if (!department) {
    return { ok: false, error: "holderDepartmentId does not reference an existing department" };
  }
  if (department.status !== "ACTIVE") {
    return { ok: false, error: "Cannot allocate to an inactive department" };
  }
  return { ok: true };
}

/**
 * Resolves "which department is this holder associated with" — the
 * department itself for a DEPARTMENT holder, or the employee's own
 * department for an EMPLOYEE holder. Used to check whether a Department
 * Head is allowed to act on a given allocation/transfer request.
 */
export async function resolveHolderDepartmentId(
  holderType: HolderType,
  holderEmployeeId?: string | null,
  holderDepartmentId?: string | null
): Promise<string | null> {
  if (holderType === "DEPARTMENT") {
    return holderDepartmentId ?? null;
  }
  if (!holderEmployeeId) return null;
  const user = await prisma.user.findUnique({
    where: { id: holderEmployeeId },
    select: { departmentId: true },
  });
  return user?.departmentId ?? null;
}

export const holderIncludeSelect = {
  holderEmployee: { select: { id: true, name: true, email: true } },
  holderDepartment: { select: { id: true, name: true } },
} as const;
