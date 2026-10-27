"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal, Plus, X } from "lucide-react";
import { loadSplitsAction, saveSplitsAction, saveTagsAction } from "@/app/transactions/actions";
import { useFormat } from "./format";
import { Button, Input, Select } from "./ui";

type Part = { categoryId: string; amount: string; note: string };

/**
 * Tags and splits for one transaction, behind a small "…" button so the list
 * stays a list. Splits must add up to the payment; the remainder is shown
 * live so the last part is easy to fill.
 */
export function TransactionExtras({
  id,
  amountCents,
  currency,
  tags,
  categories,
}: {
  id: number;
  amountCents: number;
  currency: string;
  tags: string[];
  categories: { id: number; name: string; icon: string | null; kind: string }[];
}) {
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [tagText, setTagText] = useState(tags.join(", "));
  const [parts, setParts] = useState<Part[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sign = Math.sign(amountCents) || -1;

  const show = () => {
    setOpen(true);
    start(async () => {
      const existing = await loadSplitsAction(id);
      setParts(
        existing.length
          ? existing.map((p) => ({ categoryId: p.categoryId ? String(p.categoryId) : "", amount: String(Math.abs(p.amount)), note: p.note ?? "" }))
          : [],
      );
    });
  };

  const assigned = (parts ?? []).reduce((s, p) => s + Math.round((Number(p.amount.replace(",", ".")) || 0) * 100), 0);
  const left = Math.abs(amountCents) - assigned;

  if (!open)
    return (
      <button type="button" onClick={show} aria-label="Tags and split" title="Tags and split" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink">
        <MoreHorizontal size={15} />
      </button>
    );

  return (
    <div className="col-span-full mt-2 space-y-3 rounded-xl border border-border bg-surface-2/60 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-xs font-medium text-ink-2" htmlFor={`tags-${id}`}>
            Tags
          </label>
          <div className="flex gap-2">
            <Input id={`tags-${id}`} value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="trip-japan, reimbursable" className="min-w-0 flex-1" />
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await saveTagsAction(id, tagText.split(",").map((t) => t.trim()).filter(Boolean));
                  setMsg({ ok: r.ok, text: r.message });
                })
              }
            >
              Save tags
            </Button>
          </div>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-muted hover:text-ink">
          <X size={15} />
        </button>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-medium text-ink-2">Split over categories</span>
          {parts && parts.length > 0 && (
            <span className={left === 0 ? "text-good-text" : "text-muted"}>
              {left === 0 ? "adds up" : `${f.money(left, { currency })} ${left > 0 ? "left" : "too much"}`}
            </span>
          )}
        </div>
        {parts === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : (
          <div className="space-y-2">
            {parts.map((p, i) => (
              <div key={i} className="flex gap-2">
                <Select
                  aria-label="Category"
                  value={p.categoryId}
                  onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, categoryId: e.target.value } : x)))}
                  className="min-w-0 flex-1"
                >
                  <option value="">Uncategorized</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label="Amount"
                  inputMode="decimal"
                  value={p.amount}
                  onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  className="w-24 text-right"
                  placeholder={left > 0 ? String(left / 100) : "0"}
                />
                <Button size="sm" variant="ghost" aria-label="Remove part" onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                  <X size={14} />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setParts([...(parts.length ? parts : [{ categoryId: "", amount: "", note: "" }]), { categoryId: "", amount: left > 0 && parts.length ? String(left / 100) : "", note: "" }])
                }
              >
                <Plus size={14} /> {parts.length ? "Add a part" : "Split this payment"}
              </Button>
              {parts.length > 0 && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={pending || (parts.length > 0 && left !== 0)}
                  onClick={() =>
                    start(async () => {
                      const r = await saveSplitsAction(
                        id,
                        parts.map((p) => ({ categoryId: p.categoryId ? Number(p.categoryId) : null, amount: sign * (Number(p.amount.replace(",", ".")) || 0), note: p.note || null })),
                      );
                      setMsg({ ok: r.ok, text: r.message });
                    })
                  }
                >
                  Save split
                </Button>
              )}
              {parts.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    start(async () => {
                      const r = await saveSplitsAction(id, []);
                      setParts([]);
                      setMsg({ ok: r.ok, text: r.message });
                    })
                  }
                >
                  Remove split
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {msg && <p className={msg.ok ? "text-xs text-good-text" : "text-xs text-critical-text"}>{msg.text}</p>}
    </div>
  );
}
