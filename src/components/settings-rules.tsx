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
  matchType: "contains" | "starts" | "exact";
  accountId: number | null;
  direction: "in" | "out" | null;
  minAmountCents: number | null;
  maxAmountCents: number | null;
  renameTo: string | null;
  addTag: string | null;
}

/** "starts with · Card only · out · 200–∞ · → Amazon · #work" */
function conditions(r: RuleItem, accountName: Map<number, string>) {
  const out: string[] = [];
  if (r.matchType !== "contains") out.push(r.matchType === "starts" ? "starts with" : "exactly");
  if (r.accountId) out.push(`${accountName.get(r.accountId) ?? "an account"} only`);
  if (r.direction) out.push(r.direction === "in" ? "money in" : "money out");
  if (r.minAmountCents != null || r.maxAmountCents != null)
    out.push(`${r.minAmountCents != null ? r.minAmountCents / 100 : 0}–${r.maxAmountCents != null ? r.maxAmountCents / 100 : "∞"}`);
  if (r.renameTo) out.push(`shown as “${r.renameTo}”`);
  if (r.addTag) out.push(`#${r.addTag}`);
  return out.join(" · ");
}

export function RulesEditor({
  rules,
  categories,
  uncategorized,
  accounts = [],
}: {
  rules: RuleItem[];
  categories: CategoryItem[];
  uncategorized: number;
  accounts?: { id: number; name: string }[];
}) {
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [more, setMore] = useState(false);
  const [matchType, setMatchType] = useState<"contains" | "starts" | "exact">("contains");
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState("");
  const [minAmount, setMin] = useState("");
  const [maxAmount, setMax] = useState("");
  const [renameTo, setRename] = useState("");
  const [addTag, setTag] = useState("");
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const num = (s: string) => (s.trim() ? Number(s.replace(",", ".")) : null);
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
            const res = await addRule({
              pattern,
              categoryId: Number(categoryId),
              matchType,
              accountId: accountId ? Number(accountId) : null,
              direction: (direction || null) as "in" | "out" | null,
              minAmount: num(minAmount),
              maxAmount: num(maxAmount),
              renameTo: renameTo || null,
              addTag: addTag || null,
            });
            if (res.ok) {
              setPattern("");
              setRename("");
              setTag("");
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
        <button type="button" onClick={() => setMore(!more)} className="mt-2 text-xs text-accent hover:underline" aria-expanded={more}>
          {more ? "Fewer options" : "More conditions: account, amount, rename, tag…"}
        </button>
        {more && (
          <div className="mt-2 grid gap-2 rounded-lg bg-surface-2 p-3 text-sm sm:grid-cols-3">
            <Select aria-label="How to match" value={matchType} onChange={(e) => setMatchType(e.target.value as typeof matchType)}>
              <option value="contains">Label contains it</option>
              <option value="starts">Label starts with it</option>
              <option value="exact">Label is exactly it</option>
            </Select>
            <Select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">On any account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Only on {a.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="">Money in or out</option>
              <option value="out">Only money out</option>
              <option value="in">Only money in</option>
            </Select>
            <Input aria-label="Minimum amount" inputMode="decimal" value={minAmount} onChange={(e) => setMin(e.target.value)} placeholder="Amount from…" />
            <Input aria-label="Maximum amount" inputMode="decimal" value={maxAmount} onChange={(e) => setMax(e.target.value)} placeholder="…up to" />
            <span />
            <Input aria-label="Rename payee to" value={renameTo} onChange={(e) => setRename(e.target.value)} placeholder="Show the payee as… (e.g. Amazon)" />
            <Input aria-label="Add tag" value={addTag} onChange={(e) => setTag(e.target.value)} placeholder="Add tag (e.g. work)" />
          </div>
        )}
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
              <span className="min-w-0 flex-1 truncate text-ink-2" title={conditions(r, accountName) || undefined}>
                {icons.get(r.categoryId) ? `${icons.get(r.categoryId)} ` : ""}
                {r.categoryName}
                {conditions(r, accountName) && <span className="ml-1.5 text-xs text-muted">· {conditions(r, accountName)}</span>}
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
