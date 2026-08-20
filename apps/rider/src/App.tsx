import { useCallback, useEffect, useState } from "react";

/**
 * Rider PWA — high-contrast (FR-45), offline status queue (DC-15).
 * Feed → accept → status flow → proof → cash ledger + remittance.
 * Auth: paste-token dev flow (OTP login UI arrives with the mobile app, Phase 12).
 */

const S = {
  page: { fontFamily: "system-ui, sans-serif", background: "#111", color: "#fff", minHeight: "100vh", maxWidth: 480, margin: "0 auto", padding: "0.75rem" } as const,
  card: { background: "#1d1d1d", border: "1px solid #333", borderRadius: 10, padding: "0.8rem", marginBottom: "0.6rem" } as const,
  btn: { background: "#ffd400", color: "#111", fontWeight: 700, border: 0, borderRadius: 8, padding: "0.9rem", width: "100%", fontSize: "1.05rem", cursor: "pointer" } as const,
  btn2: { background: "#333", color: "#fff", border: "1px solid #555", borderRadius: 8, padding: "0.7rem", width: "100%", cursor: "pointer" } as const,
  input: { width: "100%", padding: "0.7rem", borderRadius: 8, border: "1px solid #444", background: "#222", color: "#fff", boxSizing: "border-box" as const } as const
};

interface Offer {
  job_id: string;
  fee: { amount_minor: string };
  cod: boolean;
  cod_amount: { amount_minor: string } | null;
  dropoff: { lat: number; lng: number; landmark: string };
}

interface QueuedStatus {
  jobId: string;
  event_id: string;
  status: string;
  at: string;
}

function fcfa(m: { amount_minor: string } | null): string {
  if (!m) return "—";
  return `${BigInt(m.amount_minor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} FCFA`;
}

export function App() {
  const [token, setToken] = useState(localStorage.getItem("rider_token") ?? "");
  const [feed, setFeed] = useState<Offer[]>([]);
  const [activeJob, setActiveJob] = useState<string | null>(localStorage.getItem("active_job"));
  const [jobStatus, setJobStatus] = useState<string>(localStorage.getItem("active_job_status") ?? "accepted");
  const [otp, setOtp] = useState("");
  const [cash, setCash] = useState<{ outstanding: { amount_minor: string } } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [msg, setMsg] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T | null> => {
      const res = await fetch(`/api${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init?.headers ?? {}) }
      }).catch(() => null);
      if (!res?.ok) {
        setMsg(res ? `Erreur ${res.status}` : "Hors ligne");
        return null;
      }
      return res.json() as Promise<T>;
    },
    [token]
  );

  const flushQueue = useCallback(async () => {
    const q = JSON.parse(localStorage.getItem("rider_status_queue") ?? "[]") as QueuedStatus[];
    const remaining: QueuedStatus[] = [];
    for (const ev of q) {
      const ok = await call(`/jobs/${ev.jobId}/status`, {
        method: "POST",
        body: JSON.stringify({ event_id: ev.event_id, status: ev.status, at: ev.at })
      });
      if (ok === null) remaining.push(ev);
    }
    localStorage.setItem("rider_status_queue", JSON.stringify(remaining));
  }, [call]);

  useEffect(() => {
    const up = () => {
      setOnline(true);
      void flushQueue();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [flushQueue]);

  const loadFeed = useCallback(async () => {
    const f = await call<Offer[]>("/rider/feed");
    if (f) setFeed(f);
    const c = await call<typeof cash>("/rider/cash");
    if (c) setCash(c);
  }, [call]);

  useEffect(() => {
    if (token) void loadFeed();
  }, [token, loadFeed]);

  const sendStatus = async (status: string) => {
    if (!activeJob) return;
    const ev: QueuedStatus = { jobId: activeJob, event_id: crypto.randomUUID(), status, at: new Date().toISOString() };
    if (!online) {
      const q = JSON.parse(localStorage.getItem("rider_status_queue") ?? "[]") as QueuedStatus[];
      localStorage.setItem("rider_status_queue", JSON.stringify([...q, ev]));
      setJobStatus(status);
      localStorage.setItem("active_job_status", status);
      setMsg("Enregistré hors ligne — synchronisation automatique");
      return;
    }
    const gps = { lat: 12.37, lng: -1.52 };
    const r = await call<{ status: string }>(`/jobs/${activeJob}/status`, {
      method: "POST",
      body: JSON.stringify({ ...ev, gps })
    });
    if (r) {
      setJobStatus(r.status);
      localStorage.setItem("active_job_status", r.status);
    }
  };

  if (!token) {
    return (
      <main style={S.page}>
        <h1>SunuMarket Livreur</h1>
        <p>Collez votre jeton d'accès (connexion OTP dans l'app mobile) :</p>
        <input style={S.input} value={token} onChange={(e) => setToken(e.target.value)} placeholder="jeton…" />
        <div style={{ height: 8 }} />
        <button style={S.btn} onClick={() => localStorage.setItem("rider_token", token)}>
          Se connecter
        </button>
      </main>
    );
  }

  return (
    <main style={S.page}>
      <h1 style={{ fontSize: "1.2rem" }}>🏍️ SunuMarket Livreur</h1>
      {!online && <div style={{ ...S.card, borderColor: "#ffd400" }}>Hors ligne — vos statuts seront synchronisés.</div>}
      {msg && <div style={S.card}>{msg}</div>}

      {cash && (
        <div style={S.card}>
          💰 Espèces à remettre : <strong>{fcfa(cash.outstanding)}</strong>
          {BigInt(cash.outstanding.amount_minor) > 0n && (
            <button
              style={{ ...S.btn2, marginTop: 8 }}
              onClick={async () => {
                const r = await call(`/riders/remittances`, {
                  method: "POST",
                  body: JSON.stringify({
                    amount: { amount_minor: cash.outstanding.amount_minor, currency: "XOF" },
                    rail: "PI_SPI",
                    idempotency_key: crypto.randomUUID()
                  })
                });
                if (r) {
                  setMsg("Remise PI-SPI effectuée ✓");
                  void loadFeed();
                }
              }}
            >
              Remettre via PI-SPI (instantané)
            </button>
          )}
        </div>
      )}

      {activeJob ? (
        <div style={S.card}>
          <strong>Course en cours</strong> — statut : {jobStatus}
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {jobStatus === "accepted" && <button style={S.btn} onClick={() => sendStatus("picked_up")}>📦 Colis récupéré</button>}
            {jobStatus === "picked_up" && <button style={S.btn} onClick={() => sendStatus("en_route")}>🛵 En route</button>}
            {jobStatus === "en_route" && <button style={S.btn} onClick={() => sendStatus("arrived")}>📍 Arrivé</button>}
            {jobStatus === "arrived" && (
              <>
                <input style={S.input} placeholder="Code de réception du client (4 chiffres)" value={otp} onChange={(e) => setOtp(e.target.value)} />
                <button
                  style={S.btn}
                  onClick={async () => {
                    const r = await call(`/jobs/${activeJob}/proof`, {
                      method: "POST",
                      body: JSON.stringify({ kind: "otp", code: otp })
                    });
                    if (r) {
                      setMsg("Livraison confirmée ✓");
                      setActiveJob(null);
                      localStorage.removeItem("active_job");
                      void loadFeed();
                    }
                  }}
                >
                  ✅ Confirmer la livraison
                </button>
              </>
            )}
            <button
              style={S.btn2}
              onClick={async () => {
                const r = await call(`/jobs/${activeJob}/incident`, {
                  method: "POST",
                  body: JSON.stringify({ reason: "client injoignable" })
                });
                if (r) {
                  setMsg("Incident signalé");
                  setActiveJob(null);
                  localStorage.removeItem("active_job");
                }
              }}
            >
              ⚠️ Signaler un problème
            </button>
          </div>
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: "1rem" }}>Courses disponibles</h2>
          {feed.length === 0 && <p style={{ color: "#999" }}>Aucune course pour le moment.</p>}
          {feed.map((o) => (
            <div key={o.job_id} style={S.card}>
              <div>📍 {o.dropoff.landmark}</div>
              <div>
                Course : <strong>{fcfa(o.fee)}</strong>
                {o.cod && <span style={{ color: "#ffd400" }}> · 💵 COD {fcfa(o.cod_amount)}</span>}
              </div>
              <button
                style={{ ...S.btn, marginTop: 8 }}
                onClick={async () => {
                  const r = await call<{ id: string; status: string }>(`/jobs/${o.job_id}/accept`, { method: "POST", body: "{}" });
                  if (r) {
                    setActiveJob(o.job_id);
                    setJobStatus("accepted");
                    localStorage.setItem("active_job", o.job_id);
                    localStorage.setItem("active_job_status", "accepted");
                  } else {
                    setMsg("Course déjà prise");
                    void loadFeed();
                  }
                }}
              >
                ✋ Accepter
              </button>
            </div>
          ))}
          <button style={S.btn2} onClick={loadFeed}>🔄 Actualiser</button>
        </>
      )}
    </main>
  );
}
