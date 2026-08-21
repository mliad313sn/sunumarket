import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatMoney, type AttemptView, type CheckoutMethod, type MoneyWire, type ProductView } from "./lib/api.js";
import { funnel, track } from "./lib/analytics.js";
import { getLocale, setLocale, t } from "./lib/i18n.js";
import { OfflineQueue } from "./lib/offline-queue.js";
import { isExpired, resend as ussdResend, secondsLeft, secondsOnScreen, startUssd, type UssdState } from "./lib/ussd.js";
import { BrandMark, Icon } from "./icons.js";

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

/** Honest placeholder — the mock catalog ships no real image assets (title in tooltip). */
function Media({ large, hint }: { large?: boolean; hint?: string | undefined }) {
  return (
    <div className={large ? "media media--lg" : "media"} title={hint} aria-hidden="true">
      <Icon name="image" size={large ? 28 : 22} />
    </div>
  );
}

function SkeletonList() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card">
          <div className="skel" style={{ height: 88, marginBottom: "0.6rem" }} />
          <div className="skel" style={{ height: 14, width: "60%" }} />
          <div className="skel" style={{ height: 14, width: "35%", marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const online = useOnline();
  const [, force] = useState(0);
  const dataSaver = localStorage.getItem("data_saver") === "1";

  return (
    <main className="page">
      <header className="header">
        <a href="#/" className="brand">
          <BrandMark />
          <span>{t("app_title")}</span>
        </a>
        <div className="header-tools">
          <label className="tool-chip">
            <input
              type="checkbox"
              checked={dataSaver}
              onChange={(e) => {
                localStorage.setItem("data_saver", e.target.checked ? "1" : "0");
                force((x) => x + 1);
              }}
            />
            <span className="dot" />
            {t("data_saver")}
          </label>
          <button
            className="tool-chip"
            aria-label={t("language")}
            onClick={() => {
              setLocale(getLocale() === "fr" ? "en" : "fr");
              force((x) => x + 1);
            }}
          >
            {getLocale().toUpperCase()}
          </button>
        </div>
      </header>
      {!online && <div className="notice-warn">{t("offline_banner")}</div>}
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
      <p className="tagline">{t("tagline")}</p>
      <div className="search">
        <Icon name="search" size={16} />
        <input
          className="input"
          aria-label={t("search_placeholder")}
          placeholder={t("search_placeholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <h2 className="section-title">{t("marketplace")}</h2>
      {items === null && <SkeletonList />}
      {items?.length === 0 && <p className="muted">{t("empty_marketplace")}</p>}
      {items?.map((p) => (
        <a key={p.id} href={`#/p/${p.id}`} className="product-link">
          <div className="card product-card">
            {!dataSaver && p.images?.[0] && <Media hint={p.images[0]} />}
            <div className="product-title">{p.title}</div>
            <div className="product-meta">
              <span className="price">{formatMoney(p.price)}</span>
              <span className={p.stock > 0 ? "chip-stock" : "chip-stock chip-stock--out"}>
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
  if (!p) return <p className="muted">{t("loading")}</p>;
  return (
    <div>
      {!dataSaver && <Media large hint={p.images?.[0]} />}
      <h2>{p.title}</h2>
      <div className="price price-lg">{formatMoney(p.price)}</div>
      {p.description && <p className="muted" style={{ fontSize: "0.9375rem" }}>{p.description}</p>}
      {p.shop && (
        <section className="trust">
          <div className="trust-shop">
            <span>{p.shop.name}</span>
            {p.shop.verified && (
              <span className="trust-badge">
                <Icon name="shield" size={16} />
                {t("verified_seller")}
              </span>
            )}
          </div>
          {typeof p.shop.completed_orders === "number" && (
            <div className="trust-stat">
              <strong>{p.shop.completed_orders}</strong> {t("completed_orders")}
            </div>
          )}
          {p.shop.whatsapp_phone && (
            <div className="btn-row">
              <a className="btn-ghost" href={`tel:${p.shop.whatsapp_phone}`}>
                <Icon name="phone" size={16} />
                {t("call_seller")}
              </a>
              <a className="btn-ghost" href={`https://wa.me/${p.shop.whatsapp_phone.replace("+", "")}`}>
                <Icon name="chat" size={16} />
                {t("whatsapp_seller")}
              </a>
            </div>
          )}
        </section>
      )}
      <button className="btn" disabled={p.stock === 0} onClick={() => (location.hash = `#/checkout/${p.id}`)}>
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

  if (!product) return <p className="muted">{t("loading")}</p>;
  if (queuedOffline.current)
    return (
      <div className="notice-ok">
        <Icon name="check" size={18} />
        {t("gps_saved_offline")}
      </div>
    );
  if (paid && order)
    return (
      <div className="paid-panel">
        <span className="paid-check">
          <Icon name="check" size={28} />
        </span>
        <div className="paid-title">{t("paid_success")}</div>
        <div className="gap" />
        <a className="btn-ghost" href={`#/track/${order.tracking_token}`}>
          {t("tracking_title")} →
        </a>
      </div>
    );

  // DC-14 USSD confirmation screen
  if (attempt?.status === "ussd_pending" && ussd) {
    const left = secondsLeft(ussd);
    return (
      <div>
        <h2>{t("ussd_title")}</h2>
        <p className="muted" style={{ fontSize: "0.9375rem" }}>{t("ussd_body")}</p>
        <div className="card ussd-panel">
          <div className="muted">{t("ussd_dial_hint")}</div>
          <div className="ussd-dial">{ussd.dialCode}</div>
          <div className="ussd-count">
            <Icon name="clock" size={14} /> {t("ussd_countdown")}:{" "}
            <strong>
              {left}
              {t("seconds")}
            </strong>
          </div>
          <div className="ussd-track">
            <div className="ussd-bar" style={{ transform: `scaleX(${left / ussd.totalSeconds})` }} />
          </div>
        </div>
        {isExpired(ussd) && <div className="notice-warn">{t("payment_failed_balance")}</div>}
        <button
          className="btn-ghost"
          onClick={async () => {
            await api(`/attempts/${attempt.id}/ussd-resend`, { method: "POST", body: "{}" }).catch(() => null);
            setUssd(ussdResend(ussd));
            funnel.ussdResent(ussd.method);
          }}
        >
          {t("ussd_resend")}
        </button>
        <div className="gap" />
        <button
          className="btn-ghost"
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
        <p className="muted" style={{ fontSize: "0.9375rem" }}>{t("qr_body")}</p>
        <div className="card qr-payload">{attempt.next_action.qr_payload}</div>
        <p className="muted">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div>
      <h2>{t("checkout_title")}</h2>
      <div className="card">
        <div className="product-title">{product.title}</div>
        <div className="price num">{formatMoney(product.price)}</div>
      </div>

      {!order && (
        <>
          <h3 className="section-title">{t("delivery_point")}</h3>
          <button className="btn-ghost" onClick={useGps}>
            <Icon name="pin" size={16} />
            {t("use_gps")}
          </button>
          {pin && (
            <p className="muted num" style={{ margin: "0.5rem 0" }}>
              <Icon name="pin" size={12} /> {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </p>
          )}
          <div className="gap" />
          <label className="field">
            <span className="field-label">{t("landmark_label")}</span>
            <input className="input" value={landmark} onChange={(e) => setLandmark(e.target.value)} />
            {landmark.length > 0 && landmark.length < 3 && <span className="field-error">{t("landmark_required")}</span>}
          </label>
          <label className="field">
            <span className="field-label">{t("phone_label")}</span>
            <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{t("consent_label")}</span>
          </label>
          {fee &&
            (fee.deliverable ? (
              <div className="card product-meta" style={{ marginTop: 0 }}>
                <span>{t("delivery_fee")}</span>
                <span className="price">{formatMoney(fee.fee)}</span>
              </div>
            ) : (
              <div className="notice-warn">{t("out_of_zone")}</div>
            ))}
          <button
            className="btn"
            disabled={!pin || landmark.length < 3 || !consent || !phone || fee?.deliverable === false}
            onClick={createOrder}
          >
            {t("checkout_title")} →
          </button>
        </>
      )}

      {order && methods && (
        <>
          <div className="card">
            <div className="product-meta" style={{ marginTop: 0 }}>
              <span>{t("total")}</span>
              <strong className="price">{formatMoney(order.total)}</strong>
            </div>
            <div className="muted num">
              {t("delivery_fee")}: {formatMoney(order.delivery_fee)}
            </div>
          </div>
          {guided && <div className="notice-warn">{t("first_payment_hint")}</div>}
          <h3 className="section-title">{t("choose_method")}</h3>
          {methods.map((m) => (
            <button
              key={m.method}
              className="method"
              aria-pressed={chosen === m.method}
              onClick={() => setChosen(m.method)}
            >
              <span className="method-radio" aria-hidden="true" />
              <span className="method-body">
                <span className="method-label">
                  {m.label}
                  {m.remembered_default && <span className="method-tag"> · {t("remembered_method")}</span>}
                </span>
                {m.fee_display && <span className="method-fee">{m.fee_display}</span>}
              </span>
            </button>
          ))}
          {chosen === "COD" && <div className="notice-warn">{t("cod_confirm")}</div>}
          {error && <div className="notice-warn">{error}</div>}
          <div className="gap" />
          <button className="btn" disabled={!chosen} onClick={() => chosen && pay(chosen)}>
            {t("pay_now")}
          </button>
        </>
      )}
      {error && !order && <div className="notice-warn">{error}</div>}
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
  if (!view) return <p className="muted">{t("loading")}</p>;
  return (
    <div>
      <h2>{t("tracking_title")}</h2>
      <div className="notice-ok">
        <Icon name="check" size={18} />
        <span>
          {t("order_status")}: {view.status}
          {view.delivery_status ? ` · ${view.delivery_status}` : ""}
        </span>
      </div>
      <ol className="timeline">
        {view.history.map((h, i) => (
          <li key={i}>
            {h.status}
            <time>{new Date(h.at).toLocaleTimeString()}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
