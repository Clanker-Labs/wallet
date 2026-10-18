"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileText, Loader2, Sparkles, Tag, Upload } from "lucide-react";
import { applyMapping, guessMapping, parseCsv, type CsvMapping, type ParsedCsv } from "@/lib/csv-import";
import { importRoute, uploadKind } from "@/lib/uploads";
import { formatBytes, KindIcon, UPLOAD_ACCEPT, uploadFile } from "@/components/assistant-uploads";
import { formatDate } from "@/lib/dates";
import { Button, ButtonLink, Card, CardHeader, Field, Select, Stat, Textarea } from "@/components/ui";
import { useFormat } from "@/components/format";
import { Disclosure } from "@/components/accounts-ui";
import { CurrencyOptions, currencyChoices } from "@/components/transactions-ui";
import { importCsvAction, type ImportResult } from "@/app/transactions/import/actions";

const MAX_BYTES = 5 * 1024 * 1024;
/** Server actions accept 1 MB bodies by default; the CSV is gzipped to fit. */
const MAX_UPLOAD = 1024 * 1024 - 64 * 1024;

type Step = "file" | "map" | "done";
interface Loaded {
  name: string;
  text: string;
  parsed: ParsedCsv;
}

/**
 * A file the importer can't map itself. Statements, OFX/QIF, screenshots,
 * CSVs without clear columns and batches go to the assistant; spreadsheets
 * and unknown types get told what to do instead.
 */
interface Handoff {
  files: File[];
  reason: "statement" | "messy" | "several" | "spreadsheet" | "unsupported";
  /** Files of a batch that nothing can read, left out of the handoff. */
  leftOut?: number;
}

/** Everything the importer and the assistant can take, so nothing is greyed out in the file dialog. */
const ACCEPT = `${UPLOAD_ACCEPT},text/csv,text/plain,.xlsx,.xls,.ods,.numbers`;

const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** UTF-8 first; fall back to Windows-1252 (common in French bank exports) when it doesn't decode cleanly. */
function decode(buf: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(buf);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buf) : utf8;
}

async function packForUpload(text: string): Promise<{ blob: Blob; encoding: "gzip" | "plain" }> {
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return { blob: await new Response(stream).blob(), encoding: "gzip" };
  }
  return { blob: new Blob([text], { type: "text/csv" }), encoding: "plain" };
}

function Steps({ step }: { step: Step }) {
  const items: [Step, string][] = [
    ["file", "File"],
    ["map", "Columns"],
    ["done", "Done"],
  ];
  const idx = items.findIndex(([s]) => s === step);
  return (
    <ol className="flex items-center gap-2 text-xs">
      {items.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-border" aria-hidden />}
          <span
            className={clsx(
              "grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold",
              i < idx ? "bg-surface-2 text-good-text" : i === idx ? "bg-accent text-accent-ink" : "bg-surface-2 text-muted",
            )}
          >
            {i < idx ? <Check size={12} /> : i + 1}
          </span>
          <span className={i === idx ? "font-medium text-ink" : "text-muted"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

export function ImportWizard({
  accounts,
  defaultAccountId,
  baseCurrency,
  assistantReady,
}: {
  accounts: { id: number; name: string; currency: string }[];
  defaultAccountId: number | null;
  baseCurrency: string;
  assistantReady: boolean;
}) {
  const f = useFormat();
  const router = useRouter();
  const [step, setStep] = useState<Step>("file");
  const [file, setFile] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [accountId, setAccountId] = useState(defaultAccountId ? String(defaultAccountId) : "");
  // Amounts are in the target account's currency unless the user says otherwise.
  const currencyFor = (id: string) => accounts.find((a) => String(a.id) === id)?.currency ?? baseCurrency;
  const [currency, setCurrency] = useState(() => currencyFor(accountId));
  const [currencyPicked, setCurrencyPicked] = useState(false);
  const currencies = currencyChoices(baseCurrency, accounts);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<Extract<ImportResult, { ok: true }> | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  /** Upload progress (0–1) while handing files to the assistant. */
  const [sending, setSending] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const load = (text: string, name: string, original?: File) => {
    setError(null);
    if (new Blob([text]).size > MAX_BYTES) return setError("That’s more than 5 MB — export a shorter period.");
    const parsed = parseCsv(text);
    if (parsed.headers.length < 2 || parsed.rows.length === 0) {
      const file = original ?? new File([text], "pasted-transactions.txt", { type: "text/plain" });
      return setHandoff({ files: [file], reason: "messy" });
    }
    setFile({ name, text, parsed });
    setMapping(guessMapping(parsed.headers));
    setStep("map");
  };

  const readFiles = async (list: File[]) => {
    if (!list.length) return;
    setError(null);
    if (list.length > 1) {
      const readable = list.filter((x) => uploadKind(x.type, x.name));
      if (readable.length > 1) {
        return setHandoff({ files: readable, reason: "several", leftOut: list.length - readable.length });
      }
      list = readable.length ? readable : [list[0]];
    }
    const picked = list[0];
    const route = importRoute(picked.type, picked.name);
    if (route !== "importer") {
      return setHandoff({ files: [picked], reason: route === "assistant" ? "statement" : route });
    }
    if (picked.size > MAX_BYTES) return setError("That file is more than 5 MB — export a shorter period.");
    try {
      load(decode(await picked.arrayBuffer()), picked.name, picked);
    } catch {
      setError("Couldn’t read that file.");
    }
  };

  const sendToAssistant = async () => {
    if (!handoff) return;
    setError(null);
    const progress = handoff.files.map(() => 0);
    setSending(0);
    try {
      const uploaded = await Promise.all(
        handoff.files.map((file, i) =>
          uploadFile(file, {
            onProgress: (p) => {
              progress[i] = p;
              setSending(progress.reduce((a, b) => a + b, 0) / progress.length);
            },
          }),
        ),
      );
      setSending(1);
      router.push(`/assistant?attach=${uploaded.map((u) => encodeURIComponent(u.id)).join(",")}`);
    } catch (e) {
      setSending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const preview = useMemo(() => (file && mapping ? applyMapping(file.parsed.rows, mapping) : null), [file, mapping]);
  const positives = preview ? preview.ok.filter((r) => r.amount > 0).length : 0;
  const mostlyPositive = !!preview && preview.ok.length >= 5 && positives / preview.ok.length > 0.8;

  const submit = () => {
    if (!file || !mapping) return;
    setError(null);
    start(async () => {
      const { blob, encoding } = await packForUpload(file.text);
      if (blob.size > MAX_UPLOAD) {
        setError("This file is too big to send in one go — split it in two (e.g. one file per year) and import both.");
        return;
      }
      const fd = new FormData();
      fd.set("csv", blob, "import.csv");
      fd.set("encoding", encoding);
      fd.set("mapping", JSON.stringify(mapping));
      fd.set("accountId", accountId);
      fd.set("currency", currency);
      try {
        const res = await importCsvAction(fd);
        if (!res.ok) return setError(res.error);
        setResult(res);
        setStep("done");
      } catch {
        setError("The import failed — the file may be too large. Try splitting it.");
      }
    });
  };

  const reset = () => {
    setFile(null);
    setMapping(null);
    setResult(null);
    setPaste("");
    setError(null);
    setHandoff(null);
    setSending(null);
    setStep("file");
  };

  const errorBox = error && (
    <p role="alert" className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-critical-text">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
    </p>
  );

  // ── Not a CSV the importer can map: hand it over, or say what to do ──
  if (step === "file" && handoff) {
    return (
      <HandoffCard
        handoff={handoff}
        assistantReady={assistantReady}
        sending={sending}
        error={errorBox}
        onSend={sendToAssistant}
        onBack={reset}
      />
    );
  }

  // ── Step 1: file ──
  if (step === "file") {
    return (
      <div className="space-y-4">
        <Steps step={step} />
        <Card className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              readFiles(Array.from(e.dataTransfer.files));
            }}
            className={clsx(
              "flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition",
              dragging ? "border-accent bg-surface-2" : "border-border",
            )}
          >
            <Upload size={28} className="text-muted" aria-hidden />
            <p className="mt-3 font-medium">Drop your bank export here</p>
            <p className="mt-1 mb-4 text-sm text-ink-2">or</p>
            <Button variant="primary" onClick={() => inputRef.current?.click()} autoFocus>
              <FileText size={15} /> Choose a file
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                readFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <p className="mt-4 text-xs text-muted">CSV up to 5 MB · “;” or “,” separated · French decimals (12,50) are fine</p>
            <p className="mt-1.5 text-xs text-ink-2">
              <Sparkles size={12} className="mr-1 inline align-[-1px] text-accent" aria-hidden />
              PDF statements, OFX/QIF and screenshots work too, through the assistant
            </p>
          </div>
          <Disclosure summary={<span className="text-sm text-ink-2">Or paste the CSV text</span>} summaryClassName="py-1">
            <div className="space-y-2 pt-3 text-sm">
              <Textarea
                rows={6}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={"Date;Libellé;Montant\n03/10/2026;CB MONOPRIX;-23,40"}
                className="font-mono text-xs"
              />
              <Button onClick={() => load(paste, "Pasted text")} disabled={!paste.trim()}>
                Use this text
              </Button>
            </div>
          </Disclosure>
          {errorBox}
        </Card>
      </div>
    );
  }

  // ── Step 3: result ──
  if (step === "done" && result) {
    return (
      <div className="space-y-4">
        <Steps step={step} />
        <Card className="space-y-5">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <Check size={20} className="text-good-text" />
            {result.inserted > 0
              ? `Imported ${result.inserted} transaction${result.inserted > 1 ? "s" : ""}`
              : "Nothing new — everything was already imported"}
          </div>
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            <Stat label="Added" value={result.inserted} />
            <Stat label="Duplicates skipped" value={result.duplicates} />
            <Stat label="Auto-categorized" value={result.categorized} />
            <Stat label="Unreadable rows" value={result.skipped} />
          </div>
          <p className="text-sm text-ink-2">Re-importing the same file later is safe — rows already imported are skipped.</p>
          <div className="flex flex-wrap gap-2">
            {result.uncategorized > 0 ? (
              <>
                <ButtonLink href="/transactions?category=none" variant="primary">
                  <Tag size={15} /> Categorize the rest ({result.uncategorized})
                </ButtonLink>
                <ButtonLink href="/transactions">Back to transactions</ButtonLink>
              </>
            ) : (
              <ButtonLink href="/transactions" variant="primary">
                See transactions
              </ButtonLink>
            )}
            <Button variant="ghost" onClick={reset}>
              Import another file
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Step 2: mapping + preview ──
  if (!file || !mapping || !preview) return null;
  const headers = file.parsed.headers;
  const split = mapping.amount === undefined;
  const set = (patch: Partial<CsvMapping>) => setMapping((m) => ({ ...m!, ...patch }));
  const columnSelect = (key: "date" | "description" | "amount" | "debit" | "credit", optional = false) => (
    <Select value={mapping[key] ?? ""} onChange={(e) => set({ [key]: e.target.value || undefined })}>
      {optional && <option value="">— None —</option>}
      {headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </Select>
  );
  const okCount = preview.ok.length;
  const delimiterLabel = file.parsed.delimiter === "\t" ? "tab" : `“${file.parsed.delimiter}”`;

  return (
    <div className="space-y-4">
      <Steps step={step} />
      <Card>
        <CardHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <FileText size={15} className="shrink-0 text-muted" />
              <span className="truncate">{file.name}</span>
            </span>
          }
          subtitle={`${file.parsed.rows.length} rows · ${delimiterLabel} separated · columns guessed, check them below`}
          action={
            <Button size="sm" variant="ghost" onClick={reset}>
              <ArrowLeft size={14} /> Other file
            </Button>
          }
        />
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_6.5rem]">
          <Field label="Date column">{columnSelect("date")}</Field>
          <Field label="Description column">{columnSelect("description")}</Field>
          <Field label="Date format">
            <Select
              value={mapping.dateFormat ?? "auto"}
              onChange={(e) => set({ dateFormat: e.target.value as CsvMapping["dateFormat"] })}
            >
              <option value="auto">Auto-detect</option>
              <option value="dmy">31/12/2026 (day first)</option>
              <option value="mdy">12/31/2026 (month first)</option>
              <option value="ymd">2026-12-31</option>
            </Select>
          </Field>
          <Field label="Into account">
            <Select
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                if (!currencyPicked) setCurrency(currencyFor(e.target.value));
              }}
            >
              <option value="">— No account —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.currency !== baseCurrency ? ` · ${a.currency}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency">
            <Select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setCurrencyPicked(true);
              }}
            >
              <CurrencyOptions codes={currencies} />
            </Select>
          </Field>
        </div>

        <div className="mt-4 space-y-3 rounded-xl border border-border p-4 text-sm">
          <div role="radiogroup" aria-label="Amount columns" className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="amountMode"
                checked={!split}
                onChange={() => {
                  const g = guessMapping(headers);
                  set({ amount: g.amount ?? mapping.debit ?? mapping.credit ?? headers[2] ?? headers[0], debit: undefined, credit: undefined });
                }}
                className="accent-accent"
              />
              One amount column (+/−)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="amountMode"
                checked={split}
                onChange={() => {
                  const g = guessMapping(headers);
                  set({ amount: undefined, debit: g.debit ?? mapping.amount, credit: g.credit });
                }}
                className="accent-accent"
              />
              Separate debit &amp; credit columns
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {split ? (
              <>
                <Field label="Debit (money out)">{columnSelect("debit", true)}</Field>
                <Field label="Credit (money in)">{columnSelect("credit", true)}</Field>
              </>
            ) : (
              <Field label="Amount column">{columnSelect("amount")}</Field>
            )}
            <label className="flex items-center gap-2 self-end pb-2 text-ink-2 lg:col-span-2">
              <input
                type="checkbox"
                checked={!!mapping.invertSign}
                onChange={(e) => set({ invertSign: e.target.checked })}
                className="h-4 w-4 accent-accent"
              />
              Flip signs (spending shows as positive)
            </label>
          </div>
          {mostlyPositive && !mapping.invertSign && (
            <p className="flex items-start gap-2 text-xs text-ink-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-muted" />
              {Math.round((positives / okCount) * 100)}% of amounts are positive. If they’re mostly spending, tick “Flip signs”.
            </p>
          )}
        </div>
      </Card>

      <Card className="px-0 sm:px-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5">
          <h2 className="text-sm font-semibold">Preview</h2>
          <p className="text-xs">
            <span className="text-good-text">
              <Check size={12} className="mr-0.5 inline" />
              {okCount} ready
            </span>
            {preview.errors.length > 0 && (
              <span className="text-critical-text"> · {preview.errors.length} can’t be read (skipped)</span>
            )}
          </p>
        </div>
        {preview.errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 px-5 text-xs text-muted">
            {preview.errors.slice(0, 3).map((e) => (
              <li key={e.row}>
                Row {e.row}: {e.reason}
              </li>
            ))}
            {preview.errors.length > 3 && <li>…and {preview.errors.length - 3} more</li>}
          </ul>
        )}
        {okCount > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border text-left text-xs text-muted">
                  <th className="py-2 pr-3 pl-5 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Description</th>
                  <th className="py-2 pr-5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.ok.slice(0, 10).map((r, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 pl-5 whitespace-nowrap text-ink-2">{formatDate(r.date)}</td>
                    <td className="max-w-[18rem] truncate py-2 pr-3">{r.description}</td>
                    <td
                      className={clsx(
                        "tabular py-2 pr-5 text-right font-medium whitespace-nowrap",
                        r.amount > 0 ? "text-good-text" : "text-ink",
                      )}
                    >
                      {f.units(r.amount, { signed: true, currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {okCount > 10 && <p className="px-5 pt-2 text-xs text-muted">…and {okCount - 10} more</p>}
          </div>
        ) : (
          <p className="mt-3 px-5 text-sm text-ink-2">No row can be read with these columns — try another date or amount column.</p>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={submit} disabled={pending || okCount === 0}>
          {pending ? (
            <>
              <Loader2 size={15} className="animate-spin" /> Importing…
            </>
          ) : (
            `Import ${okCount} transaction${okCount === 1 ? "" : "s"}`
          )}
        </Button>
        <span className="text-xs text-muted">Duplicates from earlier imports are skipped automatically.</span>
      </div>
      {errorBox}
    </div>
  );
}

const KIND_NOUN = { pdf: "PDF statement", image: "screenshot" } as const;

function HandoffCard({
  handoff,
  assistantReady,
  sending,
  error,
  onSend,
  onBack,
}: {
  handoff: Handoff;
  assistantReady: boolean;
  sending: number | null;
  error: ReactNode;
  onSend: () => void;
  onBack: () => void;
}) {
  const { files, reason } = handoff;
  const first = files[0];
  const toAssistant = reason === "statement" || reason === "messy" || reason === "several";
  const kind = uploadKind(first.type, first.name);
  const noun =
    kind === "pdf" || kind === "image" ? KIND_NOUN[kind] : `${extOf(first.name).toUpperCase()} export`;

  const [title, body] = {
    statement: [
      `Send this ${noun} to the assistant`,
      `This page reads CSV files. The assistant reads ${noun}s: it pulls out the transactions, matches them to an account and imports them.`,
    ],
    messy: [
      "Couldn’t find the columns",
      "This file doesn’t look like a regular CSV: no header row, or an unusual layout. The assistant can usually work it out and import the transactions.",
    ],
    several: [
      `Import ${files.length} files with the assistant`,
      "This page takes one CSV at a time. The assistant imports them all in one go, each into the right account.",
    ],
    spreadsheet: [
      "Save it as CSV first",
      "Spreadsheet files can’t be read yet. Open it in Excel, Numbers or Sheets, export it as CSV (File → Save As, or Export), then drop the .csv here.",
    ],
    unsupported: [
      `Wallet can’t read .${extOf(first.name)} files`,
      "Drop a CSV export, a PDF statement, an OFX/QIF file or a screenshot instead.",
    ],
  }[reason];

  return (
    <Card className="space-y-5">
      <div className="flex items-start gap-3.5">
        <span
          className={clsx(
            "grid h-10 w-10 shrink-0 place-items-center rounded-xl",
            toAssistant ? "bg-brand-gradient text-white shadow-card" : "bg-surface-2 text-muted",
          )}
          aria-hidden
        >
          {toAssistant ? <Sparkles size={18} /> : <KindIcon kind={reason === "spreadsheet" ? "csv" : null} size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-ink">{title}</h2>
          <p className="mt-1 text-sm text-ink-2">{body}</p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {files.map((file, i) => (
          <li key={i} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
            <KindIcon kind={uploadKind(file.type, file.name)} size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-ink" title={file.name}>
              {file.name}
            </span>
            <span className="shrink-0 text-xs text-muted tabular">{formatBytes(file.size)}</span>
          </li>
        ))}
        {!!handoff.leftOut && (
          <li className="px-1 text-xs text-muted">
            {handoff.leftOut === 1 ? "1 other file isn’t" : `${handoff.leftOut} other files aren’t`} a type Wallet can read,
            so {handoff.leftOut === 1 ? "it’s" : "they’re"} left out.
          </li>
        )}
      </ul>

      {toAssistant && !assistantReady && (
        <p className="text-sm text-ink-2">The assistant isn’t set up yet: give it an AI provider in Settings first.</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {toAssistant && assistantReady && (
          <Button variant="primary" onClick={onSend} disabled={sending !== null} autoFocus>
            {sending === null ? (
              <>
                Import with the assistant <ArrowRight size={15} />
              </>
            ) : (
              <>
                <Loader2 size={15} className="animate-spin" />
                {sending < 1 ? `Uploading… ${Math.round(sending * 100)}%` : "Opening the assistant…"}
              </>
            )}
          </Button>
        )}
        {toAssistant && !assistantReady && (
          <ButtonLink href="/settings#integrations" variant="primary">
            Set up the assistant <ArrowRight size={15} />
          </ButtonLink>
        )}
        <Button variant={toAssistant ? "ghost" : "primary"} onClick={onBack} disabled={sending !== null} autoFocus={!toAssistant}>
          <ArrowLeft size={15} /> Choose another file
        </Button>
      </div>
      {error}
    </Card>
  );
}
