"use client";

import clsx from "clsx";
import { ArrowRight, Plus, Wand2 } from "lucide-react";
import { useState, useTransition } from "react";
import { addRule, applyRules, removeRule } from "@/app/settings/actions";
import { Button, Input, Select } from "./ui";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";
import type { CategoryItem } from "./settings-categories";

export interface RuleItem {
  id: number;
  pattern: string;
  categoryId: number;
  categoryName: string;
}

export function RulesEditor({ rules, categories, uncategorized }: { rules: RuleItem[]; categories: CategoryItem[]; uncategorized: number }) {
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(5000);
  const [applyFlash, showApply] = useFlash(8000);
  const icons = new Map(categories.map((c) => [c.id, c.icon]));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
        <span className="text-sm text-ink-2">
          <span className="tabular font-semibold text-ink">{uncategorized}</span> uncategorized transaction{uncategorized === 1 ? "" : "s"}
        </span>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={pending || rules.length === 0}
          onClick={() =>
            startTransition(async () => {
              const res = await applyRules();
              if (res.ok) showApply("good", res.message ?? "Done");
            })
          }
        >
          <Wand2 size={14} /> Apply rules to uncategorized
        </Button>
        <Flash flash={applyFlash} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const res = await addRule({ pattern, categoryId: Number(categoryId) });
            if (res.ok) {
              setPattern("");
              showFlash("good", res.message ?? "Saved");
            } else showFlash("critical", res.error);
          });
        }}
      >
        <div className="mb-1 text-xs font-medium text-ink-2">When the bank label contains…</div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-40">
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="e.g. carrefour" aria-label="Text to look for" required minLength={2} />
          </div>
          <ArrowRight size={15} className="hidden text-muted sm:block" aria-hidden />
          <div className="min-w-0 flex-1 basis-40">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category" required>
              <option value="">Category…</option>
              {(["expense", "income", "transfer"] as const).map((k) => (
                <optgroup key={k} label={k === "expense" ? "Expenses" : k === "income" ? "Income" : "Transfers"}>
                  {categories
                    .filter((c) => c.kind === k)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.icon ? `${c.icon} ` : ""}
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={pending || pattern.trim().length < 2 || !categoryId}>
            <Plus size={14} /> Add rule
          </Button>
        </div>
        <div className="mt-1 min-h-4">
          <Flash flash={flash} />
        </div>
      </form>

      {rules.length === 0 ? (
        <p className="mt-3 text-sm text-ink-2">No rules yet. Rules also apply automatically when you import a CSV.</p>
      ) : (
        <ul className={clsx("mt-3 grid grid-cols-1 gap-x-8 sm:grid-cols-2", pending && "opacity-70")}>
          {rules.map((r) => (
            <li key={r.id} className="flex min-w-0 items-center gap-2 border-b border-border py-1.5 text-sm">
              <code className="min-w-0 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">{r.pattern}</code>
              <ArrowRight size={13} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ink-2">
                {icons.get(r.categoryId) ? `${icons.get(r.categoryId)} ` : ""}
                {r.categoryName}
              </span>
              <ConfirmButton
                iconOnly
                title={`Delete rule “${r.pattern}”`}
                confirmLabel="Delete?"
                disabled={pending}
                onConfirm={() =>
                  startTransition(async () => {
                    await removeRule(r.id);
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
