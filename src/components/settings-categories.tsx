"use client";

import clsx from "clsx";
import { Plus } from "lucide-react";
import { useState, useTransition, type KeyboardEvent } from "react";
import { addCategory, editCategory, removeCategory } from "@/app/settings/actions";
import { Button, Input, Select } from "./ui";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";

export type CategoryKindKey = "income" | "expense" | "transfer";

export interface CategoryItem {
  id: number;
  name: string;
  kind: CategoryKindKey;
  icon: string | null;
  txCount: number;
}

const GROUPS: { kind: CategoryKindKey; label: string }[] = [
  { kind: "expense", label: "Expenses" },
  { kind: "income", label: "Income" },
  { kind: "transfer", label: "Transfers (ignored in budgets)" },
];

export function CategoriesEditor({ categories }: { categories: CategoryItem[] }) {
  const byKind = (k: CategoryKindKey) => categories.filter((c) => c.kind === k);
  return (
    <div>
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
        <Group label={GROUPS[0].label} items={byKind("expense")} />
        <div className="min-w-0 space-y-5">
          <Group label={GROUPS[1].label} items={byKind("income")} />
          <Group label={GROUPS[2].label} items={byKind("transfer")} />
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">
        Click a name or icon to edit (Enter saves, Esc cancels). Deleting a category leaves its transactions uncategorized and
        removes its budget and rules.
      </p>
      <AddCategory />
    </div>
  );
}

function Group({ label, items }: { label: string; items: CategoryItem[] }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-xs font-medium text-muted">{label}</h3>
      {items.length === 0 ? (
        <p className="py-1.5 text-sm text-ink-2">None yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((c) => (
            <CategoryRow key={c.id} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

const inlineInput =
  "h-8 rounded-md border border-transparent bg-transparent text-sm text-ink hover:border-border focus:border-accent focus:bg-surface focus:outline-none";

function CategoryRow({ c }: { c: CategoryItem }) {
  const [name, setName] = useState(c.name);
  const [icon, setIcon] = useState(c.icon ?? "");
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(2500);

  const revert = () => {
    setName(c.name);
    setIcon(c.icon ?? "");
  };
  const commit = () => {
    const n = name.trim();
    const i = icon.trim();
    if (!n) return revert();
    if (n === c.name && i === (c.icon ?? "")) return;
    startTransition(async () => {
      const res = await editCategory(c.id, { name: n, icon: i });
      if (res.ok) showFlash("good", "Saved");
      else {
        showFlash("critical", res.error);
        revert();
      }
    });
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      revert();
      requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
    }
  };

  return (
    <li className={clsx("flex items-center gap-1 py-1", pending && "opacity-60")}>
      <input
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        maxLength={8}
        aria-label={`Icon for ${c.name}`}
        placeholder="·"
        className={clsx(inlineInput, "w-10 shrink-0 text-center")}
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={keys}
        maxLength={60}
        aria-label={`Name of ${c.name}`}
        className={clsx(inlineInput, "min-w-0 flex-1 px-2")}
      />
      <Flash flash={flash} className="shrink-0" />
      <span className="tabular w-14 shrink-0 text-right text-xs text-muted" title="Transactions in this category">
        {c.txCount} tx
      </span>
      <ConfirmButton
        iconOnly
        title={`Delete “${c.name}”`}
        confirmLabel={c.txCount ? `Delete? ${c.txCount} tx → uncategorized` : "Delete?"}
        disabled={pending}
        onConfirm={() =>
          startTransition(async () => {
            await removeCategory(c.id);
          })
        }
      />
    </li>
  );
}

function AddCategory() {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [kind, setKind] = useState<CategoryKindKey>("expense");
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(4000);
  return (
    <form
      className="mt-5 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        startTransition(async () => {
          const res = await addCategory({ name: name.trim(), icon, kind });
          if (res.ok) {
            setName("");
            setIcon("");
            showFlash("good", res.message ?? "Added");
          } else showFlash("critical", res.error);
        });
      }}
    >
      <div className="mb-1 text-xs font-medium text-ink-2">Add a category</div>
      <div className="flex flex-wrap gap-2">
        <div className="w-14 shrink-0">
          <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🙂" aria-label="Icon (emoji)" maxLength={8} className="text-center" />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Pets" aria-label="Category name" maxLength={60} required />
        </div>
        <div className="w-36 shrink-0">
          <Select value={kind} onChange={(e) => setKind(e.target.value as CategoryKindKey)} aria-label="Kind">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer</option>
          </Select>
        </div>
        <Button type="submit" disabled={pending || !name.trim()}>
          <Plus size={14} /> Add
        </Button>
      </div>
      <div className="mt-1 min-h-4">
        <Flash flash={flash} />
      </div>
    </form>
  );
}
