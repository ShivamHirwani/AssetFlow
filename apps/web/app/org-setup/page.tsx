"use client";

import { useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
import { StatusBadge } from "@/lib/status-badge";

type Department = {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE";
  head: { id: string; name: string; email: string } | null;
  parentDepartment: { id: string; name: string } | null;
  _count: { employees: number; assets: number };
};

type CustomFieldDef = { key: string; label: string; type: "text" | "number" | "date" | "boolean" };

type Category = {
  id: string;
  name: string;
  description: string | null;
  customFields: CustomFieldDef[] | null;
  _count: { assets: number };
};

type Employee = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "ACTIVE" | "INACTIVE";
  department: { id: string; name: string } | null;
  createdAt: string;
};

export default function OrgSetupPage() {
  const [tab, setTab] = useState<"departments" | "categories" | "employees">("departments");

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-semibold mb-1">Organization Setup</h1>
        <p className="text-sm text-slate-500 mb-6">
          Maintain the master data everything else depends on.
        </p>

        <div className="flex gap-2 mb-6 border-b border-slate-200">
          <TabButton active={tab === "departments"} onClick={() => setTab("departments")}>
            Departments
          </TabButton>
          <TabButton active={tab === "categories"} onClick={() => setTab("categories")}>
            Asset Categories
          </TabButton>
          <TabButton active={tab === "employees"} onClick={() => setTab("employees")}>
            Employee Directory
          </TabButton>
        </div>

        {tab === "departments" && <DepartmentsTab />}
        {tab === "categories" && <CategoriesTab />}
        {tab === "employees" && <EmployeesTab />}
      </div>
    </AppShell>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
        active ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// =======================================================================
// Tab A — Departments (create, edit, activate/deactivate)
// =======================================================================
function DepartmentsTab() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [headId, setHeadId] = useState("");
  const [parentDepartmentId, setParentDepartmentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    api<Department[]>("/departments").then(setDepartments).catch((e) => setError(e.message));
    api<Employee[]>("/users").then(setEmployees).catch(() => setEmployees([]));
  }

  useEffect(load, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setHeadId("");
    setParentDepartmentId("");
    setFormError(null);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  function startEdit(dept: Department) {
    setEditingId(dept.id);
    setName(dept.name);
    setHeadId(dept.head?.id ?? "");
    setParentDepartmentId(dept.parentDepartment?.id ?? "");
    setFormError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const body = {
        name,
        headId: headId || null,
        parentDepartmentId: parentDepartmentId || null,
      };
      if (editingId) {
        await api(`/departments/${editingId}`, { method: "PATCH", body });
      } else {
        await api("/departments", { method: "POST", body });
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to save department");
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(dept: Department) {
    setBusyId(dept.id);
    try {
      await api(`/departments/${dept.id}/${dept.status === "ACTIVE" ? "deactivate" : "activate"}`, {
        method: "POST",
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update status");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500">
          Editing a department here also drives the picklist in Allocation & Booking screens.
        </p>
        <button
          onClick={() => (showForm ? (setShowForm(false), resetForm()) : startCreate())}
          className="btn-secondary"
        >
          {showForm ? "Cancel" : "+ Add Department"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="card p-5 mb-5 space-y-3 max-w-md">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
            {editingId ? "Edit Department" : "New Department"}
          </p>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Department name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={headId}
            onChange={(e) => setHeadId(e.target.value)}
          >
            <option value="">No head assigned yet</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name} ({emp.role})
              </option>
            ))}
          </select>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            value={parentDepartmentId}
            onChange={(e) => setParentDepartmentId(e.target.value)}
          >
            <option value="">No parent department</option>
            {departments
              .filter((d) => d.id !== editingId)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "Saving..." : editingId ? "Save Changes" : "Create Department"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className="btn-secondary"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="card p-5">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <table>
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-100 text-sm">
              <th className="pb-2">Department</th>
              <th className="pb-2">Head</th>
              <th className="pb-2">Parent Dept</th>
              <th className="pb-2">Employees</th>
              <th className="pb-2">Assets</th>
              <th className="pb-2">Status</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id} className="border-b border-slate-50 last:border-0 text-sm">
                <td className="py-2 font-medium">{d.name}</td>
                <td className="py-2">{d.head?.name ?? "—"}</td>
                <td className="py-2">{d.parentDepartment?.name ?? "—"}</td>
                <td className="py-2">{d._count.employees}</td>
                <td className="py-2">{d._count.assets}</td>
                <td className="py-2">
                  <StatusBadge status={d.status} />
                </td>
                <td className="py-2 text-right space-x-2 whitespace-nowrap">
                  <button
                    onClick={() => startEdit(d)}
                    className="text-xs text-slate-600 hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => toggleStatus(d)}
                    disabled={busyId === d.id}
                    className="btn-secondary text-xs px-3 py-1"
                  >
                    {busyId === d.id ? "..." : d.status === "ACTIVE" ? "Deactivate" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =======================================================================
// Tab B — Asset Categories (create, edit incl. custom fields, delete)
// =======================================================================
const CUSTOM_FIELD_TYPES: CustomFieldDef["type"][] = ["text", "number", "date", "boolean"];

function emptyCustomField(): CustomFieldDef {
  return { key: "", label: "", type: "text" };
}

function CategoriesTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function load() {
    api<Category[]>("/asset-categories").then(setCategories).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setCustomFields([]);
    setFormError(null);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  function startEdit(cat: Category) {
    setEditingId(cat.id);
    setName(cat.name);
    setDescription(cat.description ?? "");
    setCustomFields(cat.customFields ?? []);
    setFormError(null);
    setShowForm(true);
  }

  function updateField(index: number, patch: Partial<CustomFieldDef>) {
    setCustomFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function removeField(index: number) {
    setCustomFields((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const cleanedFields = customFields
      .map((f) => ({ ...f, key: f.key.trim(), label: f.label.trim() }))
      .filter((f) => f.key && f.label);

    setSaving(true);
    try {
      const body = {
        name,
        description: description || undefined,
        customFields: cleanedFields.length > 0 ? cleanedFields : undefined,
      };
      if (editingId) {
        await api(`/asset-categories/${editingId}`, {
          method: "PATCH",
          body: { ...body, customFields: cleanedFields.length > 0 ? cleanedFields : null },
        });
      } else {
        await api("/asset-categories", { method: "POST", body });
      }
      setShowForm(false);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to save category");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/asset-categories/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete category");
    }
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => (showForm ? (setShowForm(false), resetForm()) : startCreate())}
          className="btn-secondary"
        >
          {showForm ? "Cancel" : "+ Add Category"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="card p-5 mb-5 space-y-3 max-w-md">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
            {editingId ? "Edit Category" : "New Category"}
          </p>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Category name (e.g. Electronics)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div>
            <div className="flex justify-between items-center mb-2">
              <p className="text-xs font-medium text-slate-500">
                Category-specific fields (e.g. warranty period)
              </p>
              <button
                type="button"
                onClick={() => setCustomFields((prev) => [...prev, emptyCustomField()])}
                className="text-xs text-slate-600 hover:underline"
              >
                + Add field
              </button>
            </div>
            {customFields.length === 0 && (
              <p className="text-xs text-slate-400">No custom fields for this category.</p>
            )}
            <div className="space-y-2">
              {customFields.map((field, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                    placeholder="key (e.g. warrantyMonths)"
                    value={field.key}
                    onChange={(e) => updateField(i, { key: e.target.value })}
                  />
                  <input
                    className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                    placeholder="Label (e.g. Warranty (months))"
                    value={field.label}
                    onChange={(e) => updateField(i, { label: e.target.value })}
                  />
                  <select
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                    value={field.type}
                    onChange={(e) => updateField(i, { type: e.target.value as CustomFieldDef["type"] })}
                  >
                    {CUSTOM_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeField(i)}
                    className="text-xs text-red-600 hover:underline shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "Saving..." : editingId ? "Save Changes" : "Create Category"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                className="btn-secondary"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="card p-5">
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        {categories.length === 0 ? (
          <p className="text-sm text-slate-400">No categories yet.</p>
        ) : (
          <table>
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100 text-sm">
                <th className="pb-2">Name</th>
                <th className="pb-2">Description</th>
                <th className="pb-2">Custom Fields</th>
                <th className="pb-2">Assets</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id} className="border-b border-slate-50 last:border-0 text-sm">
                  <td className="py-2 font-medium">{c.name}</td>
                  <td className="py-2 text-slate-500">{c.description ?? "—"}</td>
                  <td className="py-2">
                    {c.customFields && c.customFields.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {c.customFields.map((f) => (
                          <span
                            key={f.key}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600"
                          >
                            {f.label}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2">{c._count.assets}</td>
                  <td className="py-2 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => startEdit(c)}
                      className="text-xs text-slate-600 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={c._count.assets > 0}
                      title={c._count.assets > 0 ? "Cannot delete — assets reference this category" : "Delete"}
                      className="text-xs text-red-600 hover:underline disabled:opacity-30 disabled:no-underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =======================================================================
// Tab C — Employee Directory (promote/demote is the only place roles change)
// =======================================================================
function EmployeesTab() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api<Employee[]>("/users").then(setEmployees).catch((e) => setError(e.message));
    api<Department[]>("/departments").then(setDepartments).catch(() => setDepartments([]));
  }

  useEffect(load, []);

  async function handlePromote(id: string, role: "DEPARTMENT_HEAD" | "ASSET_MANAGER") {
    setBusyId(id);
    try {
      await api(`/users/${id}/promote`, { method: "POST", body: { role } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to promote user");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDemote(id: string) {
    setBusyId(id);
    try {
      await api(`/users/${id}/demote`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to demote user");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDepartmentChange(id: string, departmentId: string) {
    setBusyId(id);
    try {
      await api(`/users/${id}`, { method: "PATCH", body: { departmentId: departmentId || null } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update department");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleStatus(emp: Employee) {
    setBusyId(emp.id);
    try {
      await api(`/users/${emp.id}`, { method: "PATCH", body: { status: emp.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" } });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update status");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="card p-5">
      <p className="text-sm text-slate-500 mb-4">
        This is the only place roles are assigned — signup always creates an Employee.
      </p>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      <table>
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-100 text-sm">
            <th className="pb-2">Name</th>
            <th className="pb-2">Email</th>
            <th className="pb-2">Role</th>
            <th className="pb-2">Department</th>
            <th className="pb-2">Status</th>
            <th className="pb-2"></th>
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr key={emp.id} className="border-b border-slate-50 last:border-0 text-sm">
              <td className="py-2 font-medium">{emp.name}</td>
              <td className="py-2 text-slate-500">{emp.email}</td>
              <td className="py-2">
                <StatusBadge status={emp.role} />
              </td>
              <td className="py-2">
                {emp.role === "ADMIN" ? (
                  emp.department?.name ?? "—"
                ) : (
                  <select
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                    value={emp.department?.id ?? ""}
                    onChange={(e) => handleDepartmentChange(emp.id, e.target.value)}
                    disabled={busyId === emp.id}
                  >
                    <option value="">No department</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="py-2">
                <StatusBadge status={emp.status} />
              </td>
              <td className="py-2 text-right space-x-2 whitespace-nowrap">
                {emp.role === "ADMIN" ? (
                  <span className="text-xs text-slate-300">—</span>
                ) : (
                  <>
                    {emp.role === "EMPLOYEE" && (
                      <>
                        <button
                          onClick={() => handlePromote(emp.id, "DEPARTMENT_HEAD")}
                          disabled={busyId === emp.id}
                          className="text-xs text-slate-600 hover:underline"
                        >
                          → Dept Head
                        </button>
                        <button
                          onClick={() => handlePromote(emp.id, "ASSET_MANAGER")}
                          disabled={busyId === emp.id}
                          className="text-xs text-slate-600 hover:underline"
                        >
                          → Asset Manager
                        </button>
                      </>
                    )}
                    {emp.role !== "EMPLOYEE" && (
                      <button
                        onClick={() => handleDemote(emp.id)}
                        disabled={busyId === emp.id}
                        className="text-xs text-amber-600 hover:underline"
                      >
                        Demote
                      </button>
                    )}
                    <button
                      onClick={() => toggleStatus(emp)}
                      disabled={busyId === emp.id}
                      className="text-xs text-red-600 hover:underline"
                    >
                      {emp.status === "ACTIVE" ? "Deactivate" : "Activate"}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
