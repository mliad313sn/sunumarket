import { useCallback, useEffect, useState } from "react";

/**
 * Admin console — FR-42..44b. Dashboard, phone search, queues (KYC / fraud /
 * reconciliation / disputes), config panels (method toggle, route flip), audit.
 */

const S = {
  page: { fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: "1rem" } as const,
  nav: { display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 12 } as const,
  tab: (a: boolean) => ({ padding: "6px 12px", borderRadius: 6, border: "1px solid #ccc", background: a ? "#0b7d4f" : "#fff", color: a ? "#fff" : "#333", cursor: "pointer" }) as const,
  card: { border: "1px solid #e5e5e5", borderRadius: 8, padding: "0.8rem", marginBottom: "0.6rem" } as const,
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: "0.85rem" } as const,
  th: { textAlign: "left" as const, borderBottom: "2px solid #ddd", padding: 6 } as const,
  td: { borderBottom: "1px solid #eee", padding: 6 } as const,
  btn: { background: "#0b7d4f", color: "#fff", border: 0, borderRadius: 6, padding: "4px 10px", cursor: "pointer" } as const,
  input: { padding: "0.5rem", borderRadius: 6, border: "1px solid #ccc" } as const
};

type Tab = "dashboard" | "search" | "kyc" | "fraud" | "reconciliation" | "disputes" | "config" | "audit";

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
      <main style={S.page}>
        <h1>SunuMarket — Console Admin</h1>
        <input style={S.input} placeholder="jeton admin…" value={token} onChange={(e) => setToken(e.target.value)} />
        <button style={{ ...S.btn, marginLeft: 8 }} onClick={() => localStorage.setItem("admin_token", token)}>
          Entrer
        </button>
      </main>
    );
  }

  return (
    <main style={S.page}>
      <h1 style={{ fontSize: "1.3rem" }}>SunuMarket — Console Admin</h1>
      <nav style={S.nav}>
        {(["dashboard", "search", "kyc", "fraud", "reconciliation", "disputes", "config", "audit"] as Tab[]).map((x) => (
          <button key={x} style={S.tab(tab === x)} onClick={() => setTab(x)}>
            {x}
          </button>
        ))}
      </nav>
      {msg && <div style={{ ...S.card, borderColor: "#f0d264", background: "#fff8e1" }}>{msg}</div>}
      {tab === "search" && (
        <div style={{ marginBottom: 8 }}>
          <input style={S.input} placeholder="téléphone…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button style={{ ...S.btn, marginLeft: 8 }} onClick={() => load("search")}>
            🔍 Rechercher
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
      {tab !== "reconciliation" && tab !== "disputes" && (
        <pre style={{ ...S.card, overflow: "auto", fontSize: "0.75rem", maxHeight: 480 }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
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
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>Type</th>
          <th style={S.th}>Référence</th>
          <th style={S.th}>Montant</th>
          <th style={S.th}>Ancienneté</th>
          <th style={S.th}></th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f) => (
          <tr key={f.id}>
            <td style={S.td}>{f.kind}</td>
            <td style={S.td}>{f.settlement_line?.provider_ref ?? "—"}</td>
            <td style={S.td}>{f.settlement_line?.amount_minor ?? "—"}</td>
            <td style={S.td}>{f.aging_bucket}</td>
            <td style={S.td}>
              <button style={S.btn} onClick={() => onResolve(f.id)}>
                Résoudre
              </button>
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
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>Litige</th>
          <th style={S.th}>Commande</th>
          <th style={S.th}></th>
        </tr>
      </thead>
      <tbody>
        {disputes.map((d) => (
          <tr key={d.id}>
            <td style={S.td}>{d.reason}</td>
            <td style={S.td}>{d.order.id.slice(0, 8)}…</td>
            <td style={S.td}>
              <button style={S.btn} onClick={() => onResolve(d.id, "refund")}>
                Rembourser
              </button>{" "}
              <button style={{ ...S.btn, background: "#a33" }} onClick={() => onResolve(d.id, "reject")}>
                Rejeter
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
