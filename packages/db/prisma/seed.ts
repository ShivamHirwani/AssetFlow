/**
 * Smoke-test seed for AssetFlow.
 *
 * WIPES all data in the connected database and reseeds a small but
 * realistic org: 2 departments, 8 users, 3 categories, 10 assets, plus
 * allocations, a transfer request, bookings, maintenance requests, and
 * an audit cycle with a few items already marked (and several left
 * PENDING on purpose, so `/audit-cycles/:id/close` correctly rejects
 * until you finish marking them).
 *
 * Run from apps/api:
 *   pnpm --filter api exec tsx src/scripts/seed.ts
 *
 * DO NOT run against a database you care about — everything is deleted
 * before reseeding.
 */
import bcrypt from "bcryptjs";
import { prisma } from "@assetflow/db";

function daysFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60 * 1000);
}

async function wipe() {
  console.log("Wiping existing data...");
  await prisma.notification.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.auditItem.deleteMany();
  await prisma.auditAssignment.deleteMany();
  await prisma.auditCycle.deleteMany();
  await prisma.maintenanceRequest.deleteMany();
  await prisma.transferRequest.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.allocation.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.assetCategory.deleteMany();
  await prisma.session.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();
}

async function main() {
  const now = new Date();
  await wipe();

  const PASSWORD = "Password123!";
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // ---- Departments (created without a head first — head must exist as a user) ----
  console.log("Creating departments...");
  const engineering = await prisma.department.create({ data: { name: "Engineering" } });
  const operations = await prisma.department.create({ data: { name: "Operations" } });

  // ---- Users ----
  console.log("Creating users...");
  const admin = await prisma.user.create({
    data: { name: "Ana Admin", email: "admin@assetflow.test", passwordHash, role: "ADMIN" },
  });
  const assetManager = await prisma.user.create({
    data: { name: "Sam Asset-Manager", email: "manager@assetflow.test", passwordHash, role: "ASSET_MANAGER" },
  });
  const deptHeadEng = await prisma.user.create({
    data: {
      name: "Priya Sharma",
      email: "priya.deptheadeng@assetflow.test",
      passwordHash,
      role: "DEPARTMENT_HEAD",
      departmentId: engineering.id,
    },
  });
  const deptHeadOps = await prisma.user.create({
    data: {
      name: "Karan Mehta",
      email: "karan.deptheadops@assetflow.test",
      passwordHash,
      role: "DEPARTMENT_HEAD",
      departmentId: operations.id,
    },
  });
  const raj = await prisma.user.create({
    data: { name: "Raj Patel", email: "raj@assetflow.test", passwordHash, role: "EMPLOYEE", departmentId: engineering.id },
  });
  const meera = await prisma.user.create({
    data: { name: "Meera Nair", email: "meera@assetflow.test", passwordHash, role: "EMPLOYEE", departmentId: operations.id },
  });
  const arjun = await prisma.user.create({
    data: { name: "Arjun Singh", email: "arjun@assetflow.test", passwordHash, role: "EMPLOYEE", departmentId: operations.id },
  });
  const priyaEmployee = deptHeadEng; // Priya also acts as the primary allocation holder in the scenarios below

  await prisma.department.update({ where: { id: engineering.id }, data: { headId: deptHeadEng.id } });
  await prisma.department.update({ where: { id: operations.id }, data: { headId: deptHeadOps.id } });

  // ---- Asset Categories ----
  console.log("Creating asset categories...");
  const electronics = await prisma.assetCategory.create({
    data: {
      name: "Electronics",
      description: "Laptops, monitors, printers, and other electronic equipment",
      customFields: [{ key: "warrantyMonths", label: "Warranty (months)", type: "number" }],
    },
  });
  const furniture = await prisma.assetCategory.create({
    data: { name: "Furniture", description: "Desks, chairs, and other office furniture" },
  });
  const vehicles = await prisma.assetCategory.create({
    data: {
      name: "Vehicles",
      description: "Company-owned vehicles",
      customFields: [{ key: "plateNumber", label: "Plate Number", type: "text" }],
    },
  });

  // ---- Assets ----
  console.log("Creating assets...");
  const assetData = [
    { assetTag: "AF-0001", name: "Dell Latitude Laptop", serialNumber: "SN-LAP-001", categoryId: electronics.id, departmentId: engineering.id, status: "AVAILABLE" as const, location: "Engineering Floor 2" },
    { assetTag: "AF-0002", name: 'MacBook Pro 14"', serialNumber: "SN-LAP-002", categoryId: electronics.id, departmentId: engineering.id, status: "ALLOCATED" as const, location: "Engineering Floor 2" },
    { assetTag: "AF-0003", name: "Epson Projector", serialNumber: "SN-PROJ-001", categoryId: electronics.id, departmentId: engineering.id, status: "AVAILABLE" as const, location: "Conference Room A", isBookable: true },
    { assetTag: "AF-0004", name: "Ergonomic Office Chair", serialNumber: "SN-CHAIR-001", categoryId: furniture.id, departmentId: operations.id, status: "AVAILABLE" as const, location: "Operations Floor 1" },
    { assetTag: "AF-0005", name: "Toyota Innova (Company Car)", serialNumber: "SN-CAR-001", categoryId: vehicles.id, departmentId: operations.id, status: "AVAILABLE" as const, location: "Basement Parking", isBookable: true },
    { assetTag: "AF-0006", name: "Standing Desk", serialNumber: "SN-DESK-001", categoryId: furniture.id, departmentId: operations.id, status: "ALLOCATED" as const, location: "Operations Floor 1" },
    { assetTag: "AF-0007", name: "HP LaserJet Printer", serialNumber: "SN-PRINT-001", categoryId: electronics.id, departmentId: engineering.id, status: "UNDER_MAINTENANCE" as const, location: "Engineering Floor 2" },
    { assetTag: "AF-0008", name: 'Dell 27" Monitor', serialNumber: "SN-MON-001", categoryId: electronics.id, departmentId: engineering.id, status: "AVAILABLE" as const, location: "Engineering Floor 2" },
    { assetTag: "AF-0009", name: "Conference Room Whiteboard", serialNumber: "SN-WB-001", categoryId: furniture.id, departmentId: operations.id, status: "AVAILABLE" as const, location: "Conference Room B" },
    { assetTag: "AF-0010", name: "iPad Pro", serialNumber: "SN-TAB-001", categoryId: electronics.id, departmentId: engineering.id, status: "ALLOCATED" as const, location: "Engineering Floor 2" },
  ];

  const assets: Record<string, Awaited<ReturnType<typeof prisma.asset.create>>> = {};
  for (const a of assetData) {
    assets[a.assetTag] = await prisma.asset.create({
      data: { ...a, condition: "GOOD", registeredById: assetManager.id },
    });
  }

  // ---- Allocations ----
  console.log("Creating allocations...");
  const overdueAllocation = await prisma.allocation.create({
    data: {
      assetId: assets["AF-0002"].id,
      holderType: "EMPLOYEE",
      holderEmployeeId: priyaEmployee.id,
      allocatedById: assetManager.id,
      expectedReturnDate: daysFrom(now, -5), // overdue
    },
  });
  await prisma.allocation.create({
    data: {
      assetId: assets["AF-0006"].id,
      holderType: "DEPARTMENT",
      holderDepartmentId: operations.id,
      allocatedById: assetManager.id,
      // no expectedReturnDate — open-ended department allocation
    },
  });
  await prisma.allocation.create({
    data: {
      assetId: assets["AF-0010"].id,
      holderType: "EMPLOYEE",
      holderEmployeeId: meera.id,
      allocatedById: assetManager.id,
      expectedReturnDate: daysFrom(now, 3), // upcoming
    },
  });

  // ---- Transfer request (Raj requesting Priya's already-allocated laptop) ----
  console.log("Creating transfer request...");
  const transferRequest = await prisma.transferRequest.create({
    data: {
      assetId: assets["AF-0002"].id,
      fromAllocationId: overdueAllocation.id,
      toHolderType: "EMPLOYEE",
      toHolderEmployeeId: raj.id,
      requestedById: raj.id,
      reason: "Need it for a client demo next week",
    },
  });

  // ---- Bookings ----
  console.log("Creating bookings...");
  await prisma.booking.create({
    data: {
      assetId: assets["AF-0003"].id,
      requestedById: raj.id,
      startTime: minutesFrom(now, -15),
      endTime: minutesFrom(now, 45),
      purpose: "Sprint planning demo",
    },
  });
  await prisma.booking.create({
    data: {
      assetId: assets["AF-0005"].id,
      requestedById: deptHeadOps.id,
      onBehalfOfDepartmentId: operations.id,
      startTime: daysFrom(now, 1),
      endTime: minutesFrom(daysFrom(now, 1), 120),
      purpose: "Client site visit",
    },
  });
  await prisma.booking.create({
    data: {
      assetId: assets["AF-0003"].id,
      requestedById: priyaEmployee.id,
      startTime: daysFrom(now, 7),
      endTime: minutesFrom(daysFrom(now, 7), 60),
      purpose: "Town hall",
      status: "CANCELLED",
      cancelledAt: now,
      cancelReason: "Meeting postponed",
    },
  });

  // ---- Maintenance requests ----
  console.log("Creating maintenance requests...");
  await prisma.maintenanceRequest.create({
    data: {
      assetId: assets["AF-0007"].id,
      raisedById: raj.id,
      issueDescription: "Paper jam and streaking prints",
      priority: "HIGH",
      status: "IN_PROGRESS",
      decidedById: assetManager.id,
      decidedAt: daysFrom(now, -2),
      technicianName: "Ravi — External Tech Co",
      assignedAt: daysFrom(now, -1),
    },
  });
  await prisma.maintenanceRequest.create({
    data: {
      assetId: assets["AF-0004"].id,
      raisedById: meera.id,
      issueDescription: "Wobbly base, needs tightening",
      priority: "LOW",
      status: "PENDING",
    },
  });
  await prisma.maintenanceRequest.create({
    data: {
      assetId: assets["AF-0001"].id,
      raisedById: priyaEmployee.id,
      issueDescription: "Battery not charging",
      priority: "MEDIUM",
      status: "RESOLVED",
      decidedById: assetManager.id,
      decidedAt: daysFrom(now, -10),
      technicianId: assetManager.id,
      assignedAt: daysFrom(now, -9),
      resolvedAt: daysFrom(now, -7),
      resolutionNotes: "Replaced battery",
    },
  });

  // ---- Audit cycle (org-wide) ----
  console.log("Creating audit cycle...");
  const auditCycle = await prisma.auditCycle.create({
    data: {
      name: "Q1 Full Organization Spot Check",
      startDate: daysFrom(now, -3),
      endDate: daysFrom(now, 4),
      status: "IN_PROGRESS",
      createdById: admin.id,
    },
  });
  await prisma.auditAssignment.createMany({
    data: [
      { auditCycleId: auditCycle.id, auditorId: assetManager.id },
      { auditCycleId: auditCycle.id, auditorId: deptHeadEng.id },
    ],
  });

  const allAssetTags = Object.keys(assets);
  const markedNow: Record<string, "VERIFIED" | "MISSING" | "DAMAGED"> = {
    "AF-0001": "VERIFIED",
    "AF-0004": "VERIFIED",
    "AF-0008": "MISSING",
    "AF-0009": "DAMAGED",
  };
  for (const tag of allAssetTags) {
    const mark = markedNow[tag];
    await prisma.auditItem.create({
      data: {
        auditCycleId: auditCycle.id,
        assetId: assets[tag].id,
        status: mark ?? "PENDING",
        recordedById: mark ? assetManager.id : null,
        recordedAt: mark ? daysFrom(now, -1) : null,
        discrepancyNote:
          tag === "AF-0008"
            ? "Not at desk location, unable to locate during walkthrough"
            : tag === "AF-0009"
              ? "Cracked surface, corner chipped"
              : null,
      },
    });
  }
  console.log(
    `  -> ${Object.keys(markedNow).length} item(s) marked, ${allAssetTags.length - Object.keys(markedNow).length} left PENDING (close should fail until these are marked)`
  );

  // ---- A few notifications & activity log entries for realism ----
  console.log("Creating notifications and activity log entries...");
  await prisma.notification.createMany({
    data: [
      {
        userId: priyaEmployee.id,
        type: "ASSET_ASSIGNED",
        title: "Asset Assigned",
        message: `${assets["AF-0002"].name} (${assets["AF-0002"].assetTag}) has been assigned to you.`,
        entityType: "Asset",
        entityId: assets["AF-0002"].id,
      },
      {
        userId: priyaEmployee.id,
        type: "TRANSFER_REQUESTED",
        title: "Transfer Requested",
        message: `${assets["AF-0002"].name} (${assets["AF-0002"].assetTag}), currently allocated to you, has a pending transfer request.`,
        entityType: "Asset",
        entityId: assets["AF-0002"].id,
      },
      {
        userId: admin.id,
        type: "AUDIT_DISCREPANCY_FLAGGED",
        title: "Audit Discrepancy Flagged",
        message: `${assets["AF-0008"].name} (${assets["AF-0008"].assetTag}) was marked MISSING during the "${auditCycle.name}" audit.`,
        entityType: "AuditItem",
        entityId: auditCycle.id,
      },
      {
        userId: assetManager.id,
        type: "AUDIT_DISCREPANCY_FLAGGED",
        title: "Audit Discrepancy Flagged",
        message: `${assets["AF-0009"].name} (${assets["AF-0009"].assetTag}) was marked DAMAGED during the "${auditCycle.name}" audit.`,
        entityType: "AuditItem",
        entityId: auditCycle.id,
      },
    ],
  });

  await prisma.activityLog.createMany({
    data: [
      { userId: assetManager.id, action: "ASSET_REGISTERED", entityType: "Asset", entityId: assets["AF-0002"].id, metadata: { assetTag: "AF-0002" } },
      { userId: assetManager.id, action: "ASSET_ALLOCATED", entityType: "Asset", entityId: assets["AF-0002"].id, metadata: { holderType: "EMPLOYEE", holderEmployeeId: priyaEmployee.id } },
      { userId: raj.id, action: "TRANSFER_REQUESTED", entityType: "Asset", entityId: assets["AF-0002"].id, metadata: { toHolderType: "EMPLOYEE" } },
      { userId: assetManager.id, action: "MAINTENANCE_APPROVED", entityType: "MaintenanceRequest", entityId: assets["AF-0007"].id, metadata: null },
      { userId: admin.id, action: "AUDIT_CYCLE_CREATED", entityType: "AuditCycle", entityId: auditCycle.id, metadata: { assetCount: allAssetTags.length, auditorCount: 2 } },
      { userId: assetManager.id, action: "AUDIT_ITEM_MARKED", entityType: "AuditItem", entityId: auditCycle.id, metadata: { status: "MISSING" } },
      { userId: assetManager.id, action: "AUDIT_ITEM_MARKED", entityType: "AuditItem", entityId: auditCycle.id, metadata: { status: "DAMAGED" } },
    ],
  });

  console.log("\nSeed complete.\n");
  console.log("Login credentials (all users share the same password):");
  console.log(`  Password: ${PASSWORD}`);
  console.table([
    { role: "ADMIN", email: admin.email },
    { role: "ASSET_MANAGER", email: assetManager.email },
    { role: "DEPARTMENT_HEAD (Engineering)", email: deptHeadEng.email },
    { role: "DEPARTMENT_HEAD (Operations)", email: deptHeadOps.email },
    { role: "EMPLOYEE (Engineering)", email: raj.email },
    { role: "EMPLOYEE (Operations)", email: meera.email },
    { role: "EMPLOYEE (Operations)", email: arjun.email },
  ]);
  console.log(`Audit cycle id: ${auditCycle.id}  (try GET /audit-cycles/${auditCycle.id}, then mark the remaining PENDING items, then POST /audit-cycles/${auditCycle.id}/close)`);
  console.log(`Transfer request id: ${transferRequest.id}  (try POST /transfer-requests/${transferRequest.id}/decision as Priya or an Admin)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
