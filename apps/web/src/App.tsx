import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatMoney, type AttemptView, type CheckoutMethod, type MoneyWire, type ProductView } from "./lib/api.js";
import { funnel, track } from "./lib/analytics.js";
import { getLocale, setLocale, t } from "./lib/i18n.js";
import { OfflineQueue } from "./lib/offline-queue.js";
import { isExpired, resend as ussdResend, secondsLeft, secondsOnScreen, startUssd, type UssdState } from "./lib/ussd.js";

/** Hash routes: #/ (marketplace) · #/p/<id> · #/checkout/<productId> · #/track/<token> */
function useRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const offlineQueue = new OfflineQueue(localStorage, async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req.body)
  });
  return res.ok || res.status === 200;
});

function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = async () => {
      setOnline(true);
      await offlineQueue.flush();
    };
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

const S = {
  page: { fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "0 auto", padding: "0.75rem", background: "#fff", minHeight: "100vh" } as const,
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" } as const,
  brand: { color: "#0b7d4f", fontWeight: 700, fontSize: "1.2rem", textDecoration: "none" } as const,
  card: { border: "1px solid #e5e5e5", borderRadius: 10, padding: "0.75rem", marginBottom: "0.6rem" } as const,
  btn: { background: "#0b7d4f", color: "#fff", border: 0, borderRadius: 8, padding: "0.7rem 1rem", fontSize: "1rem", width: "100%", cursor: "pointer" } as const,
  btnGhost: { background: "#fff", color: "#0b7d4f", border: "1px solid #0b7d4f", borderRadius: 8, padding: "0.6rem 1rem", width: "100%", cursor: "pointer" } as const,
  chip: (active: boolean) =>
    ({ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left" as const, padding: "0.65rem", borderRadius: 8, border: active ? "2px solid #0b7d4f" : "1px solid #ddd", background: active ? "#f0faf5" : "#fff", marginBottom: 6, cursor: "pointer" }) as const,
  input: { width: "100%", padding: "0.6rem", borderRadius: 8, border: "1px solid #ccc", fontSize: "1rem", boxSizing: "border-box" as const } as const,
  warn: { background: "#fff8e1", border: "1px solid #f0d264", borderRadius: 8, padding: "0.6rem", fontSize: "0.9rem" } as const,
  ok: { background: "#e8f7ef", border: "1px solid #0b7d4f", borderRadius: 8, padding: "0.75rem", fontWeight: 600 } as const
};

export function App() {
  const route = useRoute();
  const online = useOnline();
  const [, force] = useState(0);
  const dataSaver = localStorage.getItem("data_saver") === "1";

  return (
    <main style={S.page}>
      <header style={S.header}>
        <a href="#/" style={S.brand}>{t("app_title")}</a>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.8rem" }}>
          <label>
            <input
              type="checkbox"
              checked={dataSaver}
              onChange={(e) => {
                localStorage.setItem("data_saver", e.target.checked ? "1" : "0");
                force((x) => x + 1);
              }}
            />{" "}
            {t("data_saver")}
          </label>
          <button
            style={{ border: "1px solid #ddd", background: "#fff", borderRadius: 6, cursor: "pointer", padding: "2px 8px" }}
            onClick={() => {
              setLocale(getLocale() === "fr" ? "en" : "fr");
              force((x) => x + 1);
            }}
          >
            {getLocale().toUpperCase()}
          </button>
        </div>
      </header>
      {!online && <div style={S.warn}>{t("offline_banner")}</div>}
      {route === "/" && <Marketplace dataSaver={dataSaver} />}
      {route.startsWith("/p/") && <ProductPage id={route.slice(3)} dataSaver={dataSaver} />}
      {route.startsWith("/checkout/") && <Checkout productId={route.slice(10)} online={online} />}
      {route.startsWith("/track/") && <Tracking token={route.slice(7)} />}
    </main>
  );
}

function Marketplace({ dataSaver }: { dataSaver: boolean }) {
  const [items, setItems] = useState<ProductView[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    const url = q ? `/marketplace?q=${encodeURIComponent(q)}` : "/marketplace";
    api<{ items: ProductView[] }>(url).then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [q]);

  return (
    <div>
      <p style={{ color: "#555", marginTop: 0 }}>{t("tagline")}</p>
      <input style={S.input} placeholder={t("search_placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
      <h2 style={{ fontSize: "1rem" }}>{t("marketplace")}</h2>
      {items === null && <p>{t("loading")}</p>}
      {items?.length === 0 && <p>{t("empty_marketplace")}</p>}
      {items?.map((p) => (
        <a key={p.id} href={`#/p/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div style={S.card}>
            {!dataSaver && p.images?.[0] && (
              <div style={{ background: "#f4f4f4", borderRadius: 8, height: 80, marginBottom: 6, fontSize: "0.7rem", color: "#999", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {p.images[0]}
              </div>
            )}
            <strong>{p.title}</strong>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ color: "#0b7d4f", fontWeight: 700 }}>{formatMoney(p.price)}</span>
              <span style={{ color: "#777", fontSize: "0.85rem" }}>
                {p.stock > 0 ? `${t("stock_left")}: ${p.stock}` : t("out_of_stock")}
              </span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

function ProductPage({ id, dataSaver }: { id: string; dataSaver: boolean }) {
  const [p, setP] = useState<ProductView | null>(null);
  useEffect(() => {
    api<ProductView>(`/products/${id}`).then(setP).catch(() => setP(null));
  }, [id]);
  if (!p) return <p>{t("loading")}</p>;
  return (
    <div>
      {!dataSaver && <div style={{ background: "#f4f4f4", borderRadius: 10, height: 160, marginBottom: 8 }} />}
      <h2 style={{ margin: "0 0 4px" }}>{p.title}</h2>
      <div style={{ fontSize: "1.3rem", color: "#0b7d4f", fontWeight: 700 }}>{formatMoney(p.price)}</div>
      {p.description && <p style={{ color: "#555" }}>{p.description}</p>}
      {p.shop && (
        <div style={S.card}>
          <strong>{p.shop.name}</strong>{" "}
          {p.shop.verified && <span style={{ color: "#0b7d4f" }}>✓ {t("verified_seller")}</span>}
          {typeof p.shop.completed_orders === "number" && (
            <div style={{ color: "#777", fontSize: "0.85rem" }}>
              {p.shop.completed_orders} {t("completed_orders")}
            </div>
          )}
          {p.shop.whatsapp_phone && (
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <a style={{ ...S.btnGhost, textAlign: "center", textDecoration: "none" }} href={`tel:${p.shop.whatsapp_phone}`}>
                📞 {t("call_seller")}
              </a>
              <a
                style={{ ...S.btnGhost, textAlign: "center", textDecoration: "none" }}
                href={`https://wa.me/${p.shop.whatsapp_phone.replace("+", "")}`}
              >
                💬 {t("whatsapp_seller")}
              </a>
            </div>
          )}
        </div>
      )}
      <button style={S.btn} disabled={p.stock === 0} onClick={() => (location.hash = `#/checkout/${p.id}`)}>
        {p.stock > 0 ? t("add_to_cart") : t("out_of_stock")}
      </button>
    </div>
  );
}

interface OrderView {
  id: string;
  total: MoneyWire;
  delivery_fee: MoneyWire;
  tracking_token: string;
}

function Checkout({ productId, online }: { productId: string; online: boolean }) {
  const [product, setProduct] = useState<ProductView | null>(null);
  const [phone, setPhone] = useState("");
  const [landmark, setLandmark] = useState("");
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [consent, setConsent] = useState(false);
  const [fee, setFee] = useState<{ fee: MoneyWire | null; deliverable: boolean } | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [methods, setMethods] = useState<CheckoutMethod[] | null>(null);
  const [guided, setGuided] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [ussd, setUssd] = useState<UssdState | null>(null);
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const queuedOffline = useRef(false);

  useEffect(() => {
    api<ProductView>(`/products/${productId}`).then(setProduct).catch(() => setProduct(null));
  }, [productId]);

  // countdown tick + paid polling
  useEffect(() => {
    const iv = setInterval(async () => {
      tick((x) => x + 1);
      if (attempt && !paid && ["initiated", "ussd_pending"].includes(attempt.status)) {
        const fresh = await api<AttemptView>(`/attempts/${attempt.id}`).catch(() => null);
        if (fresh) {
          setAttempt(fresh);
          if (fresh.status === "succeeded") {
            setPaid(true);
            funnel.paid(fresh.method);
          }
          if (fresh.status === "failed") {
            setError(t("payment_failed_balance"));
            funnel.failed(fresh.method, fresh.failure_reason ?? "unknown");
          }
        }
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [attempt, paid]);

  const useGps = useCallback(() => {
    navigator.geolocation.getCurrentPosition(
      (pos) => setPin({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setPin({ lat: 14.68, lng: -17.44 }) // graceful fallback pin (test env)
    );
  }, []);

  useEffect(() => {
    if (pin && product) {
      api<{ fee: MoneyWire | null; deliverable: boolean }>("/fees/quote", {
        method: "POST",
        body: JSON.stringify({ shop_id: product.shop_id, pin })
      })
        .then(setFee)
        .catch(() => setFee(null));
    }
  }, [pin, product]);

  const createOrder = useCallback(async () => {
    if (!product || !pin || !landmark || !consent) return;
    const body = {
      shop_id: product.shop_id,
      items: [{ product_id: product.id, qty: 1 }],
      delivery_point: { pin: { ...pin, landmark } },
      guest_phone: phone,
      idempotency_key: crypto.randomUUID()
    };
    if (!online) {
      offlineQueue.enqueue("/api/orders", body);
      queuedOffline.current = true;
      track("order_queued_offline", {});
      return;
    }
    const o = await api<OrderView>("/orders", { method: "POST", body: JSON.stringify(body) }).catch((e: Error) => {
      setError(e.message);
      return null;
    });
    if (!o) return;
    setOrder(o);
    const m = await api<{ methods: CheckoutMethod[]; first_payment_guided: boolean }>(`/checkout/${o.id}/methods`);
    setMethods(m.methods);
    setGuided(m.first_payment_guided);
    funnel.checkoutOpened(m.methods.length);
    const remembered = m.methods.find((x) => x.remembered_default);
    if (remembered) setChosen(remembered.method);
  }, [product, pin, landmark, consent, phone, online]);

  const pay = useCallback(
    async (method: string) => {
      if (!order) return;
      funnel.methodChosen(method, methods?.find((m) => m.method === method)?.remembered_default ?? false);
      setError(null);
      const att = await api<AttemptView>(`/orders/${order.id}/attempts`, {
        method: "POST",
        body: JSON.stringify({ method, idempotency_key: crypto.randomUUID() })
      }).catch((e: Error & { status?: number }) => {
        setError(e.status === 503 ? t("payment_outage") : e.message);
        return null;
      });
      if (!att) return;
      setAttempt(att);
      funnel.attemptCreated(method, att.provider_code ?? "none");
      if (att.status === "ussd_pending" && att.ussd) {
        setUssd(startUssd(method, att.ussd.dial_code, att.ussd.expires_in_s));
        funnel.ussdShown(method);
      }
      if (att.status === "succeeded") {
        setPaid(true);
        funnel.paid(method);
      }
      if (att.status === "failed") {
        setError(t("payment_failed_balance"));
        funnel.failed(method, att.failure_reason ?? "declined");
      }
    },
    [order, methods]
  );

  if (!product) return <p>{t("loading")}</p>;
  if (queuedOffline.current) return <div style={S.ok}>{t("gps_saved_offline")}</div>;
  if (paid && order)
    return (
      <div>
        <div style={S.ok}>{t("paid_success")}</div>
        <p>
          <a href={`#/track/${order.tracking_token}`}>{t("tracking_title")} →</a>
        </p>
      </div>
    );

  // DC-14 USSD confirmation screen
  if (attempt?.status === "ussd_pending" && ussd) {
    const left = secondsLeft(ussd);
    return (
      <div>
        <h2>{t("ussd_title")}</h2>
        <p>{t("ussd_body")}</p>
        <div style={S.card}>
          <div>
            {t("ussd_dial_hint")} <strong style={{ fontSize: "1.3rem" }}>{ussd.dialCode}</strong>
          </div>
          <div style={{ marginTop: 6 }}>
            {t("ussd_countdown")}: <strong>{left}{t("seconds")}</strong>
          </div>
        </div>
        {isExpired(ussd) && <div style={S.warn}>{t("payment_failed_balance")}</div>}
        <button
          style={S.btnGhost}
          onClick={async () => {
            await api(`/attempts/${attempt.id}/ussd-resend`, { method: "POST", body: "{}" }).catch(() => null);
            setUssd(ussdResend(ussd));
            funnel.ussdResent(ussd.method);
          }}
        >
          {t("ussd_resend")}
        </button>
        <div style={{ height: 8 }} />
        <button
          style={S.btnGhost}
          onClick={() => {
            funnel.ussdAbandoned(ussd.method, secondsOnScreen(ussd));
            setAttempt(null);
            setUssd(null);
          }}
        >
          {t("ussd_switch")}
        </button>
      </div>
    );
  }

  // PI-SPI QR screen
  if (attempt?.next_action?.kind === "qr") {
    return (
      <div>
        <h2>{t("qr_title")}</h2>
        <p>{t("qr_body")}</p>
        <div style={{ ...S.card, textAlign: "center", fontFamily: "monospace", wordBreak: "break-all" }}>
          {attempt.next_action.qr_payload}
        </div>
        <p style={{ color: "#777" }}>{t("loading")}</p>
      </div>
    );
  }

  return (
    <div>
      <h2>{t("checkout_title")}</h2>
      <div style={S.card}>
        <strong>{product.title}</strong> — {formatMoney(product.price)}
      </div>

      {!order && (
        <>
          <h3 style={{ fontSize: "0.95rem" }}>{t("delivery_point")}</h3>
          <button style={S.btnGhost} onClick={useGps}>
            {t("use_gps")}
          </button>
          {pin && (
            <p style={{ fontSize: "0.8rem", color: "#555" }}>
              📍 {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </p>
          )}
          <div style={{ height: 8 }} />
          <input style={S.input} placeholder={t("landmark_label")} value={landmark} onChange={(e) => setLandmark(e.target.value)} />
          {landmark.length > 0 && landmark.length < 3 && <small style={{ color: "#b00" }}>{t("landmark_required")}</small>}
          <div style={{ height: 8 }} />
          <input style={S.input} placeholder={t("phone_label")} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label style={{ display: "block", margin: "8px 0", fontSize: "0.9rem" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {t("consent_label")}
          </label>
          {fee && (
            <div style={fee.deliverable ? S.card : S.warn}>
              {fee.deliverable ? `${t("delivery_fee")}: ${formatMoney(fee.fee)}` : t("out_of_zone")}
            </div>
          )}
          <button style={S.btn} disabled={!pin || landmark.length < 3 || !consent || !phone || fee?.deliverable === false} onClick={createOrder}>
            {t("checkout_title")} →
          </button>
        </>
      )}

      {order && methods && (
        <>
          <div style={S.card}>
            {t("total")}: <strong>{formatMoney(order.total)}</strong>{" "}
            <small style={{ color: "#777" }}>
              ({t("delivery_fee")}: {formatMoney(order.delivery_fee)})
            </small>
          </div>
          {guided && <div style={S.warn}>{t("first_payment_hint")}</div>}
          <h3 style={{ fontSize: "0.95rem" }}>{t("choose_method")}</h3>
          {methods.map((m) => (
            <button key={m.method} style={S.chip(chosen === m.method)} onClick={() => setChosen(m.method)}>
              <span style={{ fontWeight: 600 }}>{m.label}</span>
              {m.remembered_default && <small style={{ color: "#0b7d4f" }}>· {t("remembered_method")}</small>}
              {m.fee_display && <small style={{ color: "#999", marginLeft: "auto" }}>{m.fee_display}</small>}
            </button>
          ))}
          {chosen === "COD" && <div style={S.warn}>{t("cod_confirm")}</div>}
          {error && <div style={S.warn}>{error}</div>}
          <div style={{ height: 8 }} />
          <button style={S.btn} disabled={!chosen} onClick={() => chosen && pay(chosen)}>
            {t("pay_now")}
          </button>
        </>
      )}
      {error && !order && <div style={S.warn}>{error}</div>}
    </div>
  );
}

function Tracking({ token }: { token: string }) {
  const [view, setView] = useState<{ status: string; delivery_status: string | null; history: Array<{ status: string; at: string }> } | null>(null);
  useEffect(() => {
    const load = () => api<typeof view>(`/track/${token}`).then(setView).catch(() => setView(null));
    void load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [token]);
  if (!view) return <p>{t("loading")}</p>;
  return (
    <div>
      <h2>{t("tracking_title")}</h2>
      <div style={S.ok}>
        {t("order_status")}: {view.status}
        {view.delivery_status ? ` · ${view.delivery_status}` : ""}
      </div>
      <ul>
        {view.history.map((h, i) => (
          <li key={i}>
            {h.status} — {new Date(h.at).toLocaleTimeString()}
          </li>
        ))}
      </ul>
    </div>
  );
}
