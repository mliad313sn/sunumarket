import { useCallback, useEffect, useState } from "react";
import { BrandMark, Icon } from "./icons.js";

/**
 * Rider PWA — high-contrast (FR-45), offline status queue (DC-15).
 * Feed → accept → status flow → proof → cash ledger + remittance.
 * Auth: paste-token dev flow (OTP login UI arrives with the mobile app, Phase 12).
 */

const JOB_STEPS = ["accepted", "picked_up", "en_route", "arrived"] as const;

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

function JobSteps({ status }: { status: string }) {
  const idx = JOB_STEPS.indexOf(status as (typeof JOB_STEPS)[number]);
  return (
    <div className="steps" aria-hidden="true">
      {JOB_STEPS.map((s, i) => (
        <span key={s} className={i <= idx ? "done" : ""} />
      ))}
    </div>
  );
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
      <main className="page">
        <header className="header">
          <BrandMark />
          <h1>SunuMarket Livreur</h1>
        </header>
        <label className="muted" htmlFor="rider-token">
          Collez votre jeton d'accès (connexion OTP dans l'app mobile) :
        </label>
        <div className="gap" />
        <input id="rider-token" className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="jeton…" />
        <div className="gap" />
        <button className="btn" onClick={() => localStorage.setItem("rider_token", token)}>
          Se connecter
        </button>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="header">
        <BrandMark />
        <h1>SunuMarket Livreur</h1>
      </header>
      {!online && <div className="card card--warn">Hors ligne — vos statuts seront synchronisés.</div>}
      {msg && <div className="card">{msg}</div>}

      {cash && (
        <div className="card">
          <div className="row">
            <Icon name="cash" />
            <span>Espèces à remettre :</span>
            <strong className="amount amount--hi">{fcfa(cash.outstanding)}</strong>
          </div>
          {BigInt(cash.outstanding.amount_minor) > 0n && (
            <div className="stack">
              <button
                className="btn2"
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
            </div>
          )}
        </div>
      )}

      {activeJob ? (
        <div className="card">
          <strong>Course en cours</strong>
          <JobSteps status={jobStatus} />
          <div className="status-line">
            statut : <strong>{jobStatus}</strong>
          </div>
          <div className="stack">
            {jobStatus === "accepted" && (
              <button className="btn" onClick={() => sendStatus("picked_up")}>
                <Icon name="package" /> Colis récupéré
              </button>
            )}
            {jobStatus === "picked_up" && (
              <button className="btn" onClick={() => sendStatus("en_route")}>
                <Icon name="route" /> En route
              </button>
            )}
            {jobStatus === "en_route" && (
              <button className="btn" onClick={() => sendStatus("arrived")}>
                <Icon name="pin" /> Arrivé
              </button>
            )}
            {jobStatus === "arrived" && (
              <>
                <input
                  className="input"
                  placeholder="Code de réception du client (4 chiffres)"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                />
                <button
                  className="btn"
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
                  <Icon name="check" /> Confirmer la livraison
                </button>
              </>
            )}
            <button
              className="btn2"
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
              <Icon name="alert" size={16} /> Signaler un problème
            </button>
          </div>
        </div>
      ) : (
        <>
          <h2>Courses disponibles</h2>
          {feed.length === 0 && <p className="muted">Aucune course pour le moment.</p>}
          {feed.map((o) => (
            <div key={o.job_id} className="card">
              <div className="row">
                <Icon name="pin" size={16} /> {o.dropoff.landmark}
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <span>Course :</span>
                <strong className="amount">{fcfa(o.fee)}</strong>
                {o.cod && (
                  <span className="cod-tag">
                    · <Icon name="cash" size={15} /> COD {fcfa(o.cod_amount)}
                  </span>
                )}
              </div>
              <div className="stack">
                <button
                  className="btn"
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
                  <Icon name="check" /> Accepter
                </button>
              </div>
            </div>
          ))}
          <button className="btn2" onClick={loadFeed}>
            <Icon name="refresh" size={16} /> Actualiser
          </button>
        </>
      )}
    </main>
  );
}
