"use client";

import clsx from "clsx";
import { KeyRound, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import {
  connectBrokerAction,
  disconnectBrokerAction,
  syncBrokerAction,
  updateBrokerCredentialsAction,
} from "@/app/settings/actions";
import { Badge, Button, Field, Input, Select } from "./ui";
import { ConfirmButton, Flash, useFlash } from "./settings-kit";

/** What the browser may know about a connector: never any stored secret. */
export interface ConnectorOption {
  id: string;
  name: string;
  description: string;
  setupHint: string;
  docsUrl: string;
  environments: { id: string; label: string }[];
  credentialFields: { key: string; label: string; secret: boolean; placeholder?: string }[];
}

export interface ConnectionItem {
  id: number;
  provider: string;
  providerName: string;
  environmentLabel: string;
  accountId: number;
  accountName: string;
  holdingsCount: number;
  lastSync: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
}

export function BrokerConnections({
  connectors,
  connections,
  accounts,
}: {
  connectors: ConnectorOption[];
  connections: ConnectionItem[];
  /** Accounts that could receive a sync (not already linked). */
  accounts: { id: number; name: string }[];
}) {
  return (
    <div className="space-y-5">
      {connections.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {connections.map((c) => (
            <ConnectionRow key={c.id} c={c} connector={connectors.find((x) => x.id === c.provider)} />
          ))}
        </ul>
      )}
      <ConnectForm connectors={connectors} accounts={accounts} first={connections.length === 0} />
    </div>
  );
}

function ConnectionRow({ c, connector }: { c: ConnectionItem; connector?: ConnectorOption }) {
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(8000);
  const [rotating, setRotating] = useState(false);
  const failing = c.lastSyncOk === false;

  return (
    <li className={clsx("px-4 py-3", pending && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {c.providerName}
            <span className="font-normal text-muted">· {c.environmentLabel}</span>
            {failing ? <Badge tone="critical">Sync failing</Badge> : c.lastSync ? <Badge tone="good">Syncing</Badge> : null}
          </div>
          <div className="text-xs text-ink-2">
            Into{" "}
            <a href={`/accounts/${c.accountId}`} className="font-medium text-accent hover:underline">
              {c.accountName}
            </a>{" "}
            · {c.holdingsCount} position{c.holdingsCount === 1 ? "" : "s"} · {c.lastSync ? `last sync ${c.lastSync}` : "never synced"}
          </div>
          {c.lastError && (
            <div className={clsx("mt-0.5 text-xs [overflow-wrap:anywhere]", failing ? "text-critical-text" : "text-muted")}>{c.lastError}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await syncBrokerAction(c.id);
                if (r.ok) showFlash("good", r.message ?? "Synced");
                else showFlash("critical", r.error);
              })
            }
          >
            <RefreshCw size={13} className={pending ? "animate-spin" : undefined} /> Sync now
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setRotating((v) => !v)}>
            <KeyRound size={13} /> New key
          </Button>
          <ConfirmButton
            label="Disconnect"
            confirmLabel="Disconnect?"
            disabled={pending}
            onConfirm={() =>
              startTransition(async () => {
                const r = await disconnectBrokerAction(c.id);
                if (!r.ok) showFlash("critical", r.error);
              })
            }
          />
        </div>
      </div>
      {rotating && connector && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const credentials = Object.fromEntries(connector.credentialFields.map((f) => [f.key, String(data.get(f.key) ?? "")]));
            startTransition(async () => {
              const r = await updateBrokerCredentialsAction(c.id, credentials);
              if (r.ok) {
                setRotating(false);
                showFlash("good", r.message ?? "Saved");
              } else showFlash("critical", r.error);
            });
          }}
        >
          {connector.credentialFields.map((f) => (
            <Field key={f.key} label={f.label} className="min-w-0 flex-1 basis-48">
              <Input name={f.key} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} required />
            </Field>
          ))}
          <Button type="submit" size="sm" variant="primary" disabled={pending}>
            Save key
          </Button>
        </form>
      )}
      <div className="mt-1 min-h-4">
        <Flash flash={flash} />
      </div>
    </li>
  );
}

function ConnectForm({ connectors, accounts, first }: { connectors: ConnectorOption[]; accounts: { id: number; name: string }[]; first: boolean }) {
  const [open, setOpen] = useState(first);
  const [providerId, setProviderId] = useState(connectors[0]?.id ?? "");
  const connector = connectors.find((c) => c.id === providerId);
  const [environment, setEnvironment] = useState(connector?.environments[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [flash, showFlash] = useFlash(10000);

  if (!connector) return null;
  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button type="button" onClick={() => setOpen(true)}>
          <Plug size={14} /> Connect a brokerage
        </Button>
        <Flash flash={flash} />
      </div>
    );
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        const credentials = Object.fromEntries(connector.credentialFields.map((f) => [f.key, String(data.get(f.key) ?? "")]));
        const target = String(data.get("accountId") ?? "");
        startTransition(async () => {
          const r = await connectBrokerAction({ provider: connector.id, environment, credentials, accountId: target ? Number(target) : null });
          if (r.ok) {
            form.reset();
            setOpen(false);
            showFlash("good", r.message ?? "Connected");
          } else showFlash("critical", r.error);
        });
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Brokerage">
          <Select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setEnvironment(connectors.find((c) => c.id === e.target.value)?.environments[0]?.id ?? "");
            }}
          >
            {connectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Account type">
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {connector.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Sync into" hint="A new account is created in the broker’s currency">
          <Select name="accountId" defaultValue="">
            <option value="">New brokerage account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {connector.credentialFields.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input
              name={f.key}
              type={f.secret ? "password" : "text"}
              placeholder={f.placeholder}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
        ))}
      </div>
      <p className="flex gap-1.5 text-xs leading-relaxed text-ink-2">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-good-text" aria-hidden />
        <span>
          {connector.setupHint}{" "}
          <a href={connector.docsUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            API docs
          </a>
          . The key is checked with {connector.name} before it’s saved, then stored encrypted on this server.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <RefreshCw size={14} className="animate-spin" /> : <Plug size={14} />} {pending ? "Connecting…" : "Connect"}
        </Button>
        {!first && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
        <Flash flash={flash} />
      </div>
    </form>
  );
}
