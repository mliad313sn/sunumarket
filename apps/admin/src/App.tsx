import { useCallback, useEffect, useState } from "react";

/**
 * Admin console — FR-42..44b. Dashboard, phone search, queues (KYC / fraud /
 * reconciliation / disputes), config panels (method toggle, route flip), audit.
 */

type Tab = "dashboard" | "search" | "kyc" | "fraud" | "reconciliation" | "disputes" | "config" | "audit";

/** Display labels (console is FR-first; tab keys stay stable identifiers). */
const TAB_LABELS: Record<Tab, string> = {
  dashboard: "Tableau de bord",
  search: "Recherche",
  kyc: "KYC",
  fraud: "Fraude",
  reconciliation: "Réconciliation",
  disputes: "Litiges",
  config: "Configuration",
  audit: "Audit"
};

function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0b7d4f" />
      <text
        x="16"
        y="22.5"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize="18"
        fontWeight="700"
        fill="#fff"
      >
        S
      </text>
    </svg>
  );
}

export function App() {
  const [token, setToken] = useState(localStorage.getItem("admin_token") ?? "");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [data, setData] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T | null> => {
      const res = await fetch(`/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` }
      }).catch(() => null);
      if (!res?.ok) {
        setMsg(res ? `Erreur ${res.status}` : "réseau indisponible");
        return null;
      }
      return res.json() as Promise<T>;
    },
    [token]
  );

  const load = useCallback(
    async (which: Tab) => {
      setMsg(null);
      const paths: Record<Tab, string> = {
        dashboard: "/admin/dashboard",
        search: `/admin/search/phone?q=${encodeURIComponent(q)}`,
        kyc: "/admin/kyc/queue",
        fraud: "/admin/fraud/queue",
        reconciliation: "/admin/reconciliation/flags",
        disputes: "/admin/disputes",
        config: "/admin/config",
        audit: "/admin/audit"
      };
      setData(await call(paths[which]));
    },
    [call, q]
  );

  useEffect(() => {
    if (token) void load(tab);
  }, [tab, token, load]);

  if (!token) {
    return (
      <main className="page">
        <header className="header">
          <BrandMark />
          <h1>SunuMarket — Console Admin</h1>
        </header>
        <div className="toolbar">
          <input className="input" placeholder="jeton admin…" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn" onClick={() => localStorage.setItem("admin_token", token)}>
            Entrer
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="header">
        <BrandMark />
        <h1>SunuMarket — Console Admin</h1>
      </header>
      <nav className="nav">
        {(Object.keys(TAB_LABELS) as Tab[]).map((x) => (
          <button key={x} className="tab" aria-current={tab === x} onClick={() => setTab(x)}>
            {TAB_LABELS[x]}
          </button>
        ))}
      </nav>
      {msg && <div className="notice-warn">{msg}</div>}
      {tab === "search" && (
        <div className="toolbar">
          <input className="input" placeholder="téléphone…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={() => load("search")}>
            Rechercher
          </button>
        </div>
      )}
      {tab === "reconciliation" && Array.isArray(data) && (
        <ReconTable flags={data as ReconFlag[]} onResolve={async (id) => {
          await call(`/admin/reconciliation/flags/${id}/resolve`, { method: "POST", body: "{}" });
          void load("reconciliation");
        }} />
      )}
      {tab === "disputes" && Array.isArray(data) && (
        <DisputeTable disputes={data as Dispute[]} onResolve={async (id, resolution) => {
          await call(`/admin/disputes/${id}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) });
          void load("disputes");
        }} />
      )}
      {tab !== "reconciliation" && tab !== "disputes" && <pre className="json">{JSON.stringify(data, null, 2)}</pre>}
    </main>
  );
}

interface ReconFlag {
  id: string;
  kind: string;
  aging_bucket: string;
  settlement_line: { provider_ref: string; amount_minor: string } | null;
}

function ReconTable({ flags, onResolve }: { flags: ReconFlag[]; onResolve: (id: string) => void }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Référence</th>
          <th>Montant</th>
          <th>Ancienneté</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f) => (
          <tr key={f.id}>
            <td>{f.kind}</td>
            <td>{f.settlement_line?.provider_ref ?? "—"}</td>
            <td>{f.settlement_line?.amount_minor ?? "—"}</td>
            <td>{f.aging_bucket}</td>
            <td>
              <div className="actions">
                <button className="btn" onClick={() => onResolve(f.id)}>
                  Résoudre
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Dispute {
  id: string;
  reason: string;
  order: { id: string; totalMinor: string };
}

function DisputeTable({ disputes, onResolve }: { disputes: Dispute[]; onResolve: (id: string, r: "refund" | "reject") => void }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Litige</th>
          <th>Commande</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {disputes.map((d) => (
          <tr key={d.id}>
            <td>{d.reason}</td>
            <td>{d.order.id.slice(0, 8)}…</td>
            <td>
              <div className="actions">
                <button className="btn" onClick={() => onResolve(d.id, "refund")}>
                  Rembourser
                </button>
                <button className="btn btn--danger" onClick={() => onResolve(d.id, "reject")}>
                  Rejeter
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
