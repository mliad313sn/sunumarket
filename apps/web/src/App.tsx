import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  clearTokens,
  formatMoney,
  getAccessToken,
  refreshTokens,
  setTokens,
  type AttemptView,
  type CheckoutMethod,
  type MoneyWire,
  type ProductView
} from "./lib/api.js";
import { funnel, track } from "./lib/analytics.js";
import { getLocale, setLocale, statusLabel, t } from "./lib/i18n.js";
import { OfflineQueue } from "./lib/offline-queue.js";
import { isExpired, resend as ussdResend, secondsLeft, secondsOnScreen, startUssd, type UssdState } from "./lib/ussd.js";
import { BrandMark, Icon } from "./icons.js";

/** Hash routes: #/ (marketplace) · #/p/<id> · #/checkout/<productId> · #/track/<token> · #/seller */
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
        <a className="tool-chip" href="#/seller">
          <Icon name="store" size={13} />
          {t("seller_space")}
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
      {route.startsWith("/seller") && <SellerSpace />}
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

interface TrackView {
  order_id: string;
  status: string;
  delivery_status: string | null;
  history: Array<{ status: string; at: string }>;
}

const DISPUTABLE = ["in_delivery", "delivered", "completed", "delivery_issue"];
const RATABLE = ["delivered", "completed"];

function Tracking({ token }: { token: string }) {
  const [view, setView] = useState<TrackView | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeSent, setDisputeSent] = useState(false);
  const [reason, setReason] = useState("");
  const [phone, setPhone] = useState("");
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState(localStorage.getItem(`rated_${token}`) === "1");

  const load = useCallback(
    () => api<TrackView>(`/track/${token}`).then(setView).catch(() => setView(null)),
    [token]
  );
  useEffect(() => {
    void load();
    const iv = setInterval(load, 10000);
    return () => clearInterval(iv);
  }, [load]);

  const cancel = useCallback(async () => {
    setConfirmCancel(false);
    try {
      await api(`/track/${token}/cancel`, { method: "POST", body: "{}" });
      setNotice({ ok: true, text: t("cancel_success") });
    } catch {
      setNotice({ ok: false, text: t("cancel_failed") });
    }
    await load();
  }, [token, load]);

  const sendDispute = useCallback(async () => {
    if (!view || reason.length < 5 || !phone) return;
    try {
      await api(`/orders/${view.order_id}/disputes`, {
        method: "POST",
        body: JSON.stringify({ reason, guest_phone: phone })
      });
      setDisputeSent(true);
      setDisputeOpen(false);
    } catch {
      setNotice({ ok: false, text: t("dispute_failed") });
    }
  }, [view, reason, phone]);

  const sendRating = useCallback(async () => {
    if (!view || stars < 1 || !phone) return;
    try {
      await api(`/orders/${view.order_id}/ratings`, {
        method: "POST",
        body: JSON.stringify({
          target: "seller",
          stars,
          guest_phone: phone,
          ...(comment ? { comment } : {})
        })
      });
      localStorage.setItem(`rated_${token}`, "1");
      setRated(true);
    } catch (e) {
      // already_rated (409) still means "done" — persist and thank.
      if ((e as { status?: number }).status === 409) {
        localStorage.setItem(`rated_${token}`, "1");
        setRated(true);
      } else {
        setNotice({ ok: false, text: t("rate_failed") });
      }
    }
  }, [view, stars, comment, phone, token]);

  if (!view) return <p className="muted">{t("loading")}</p>;
  return (
    <div>
      <h2>{t("tracking_title")}</h2>
      <div className="notice-ok">
        <Icon name="check" size={18} />
        <span>
          {t("order_status")}: {statusLabel(view.status)}
          {view.delivery_status ? ` · ${statusLabel(view.delivery_status)}` : ""}
        </span>
      </div>
      {notice && <div className={notice.ok ? "notice-ok" : "notice-warn"}>{notice.text}</div>}

      {view.status === "payment_pending" &&
        (confirmCancel ? (
          <div className="card">
            <p className="muted" style={{ margin: "0 0 0.6rem" }}>{t("cancel_confirm")}</p>
            <div className="btn-row">
              <button className="btn-ghost btn-danger" onClick={cancel}>
                {t("cancel_yes")}
              </button>
              <button className="btn-ghost" onClick={() => setConfirmCancel(false)}>
                {t("cancel_keep")}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn-ghost btn-danger" onClick={() => setConfirmCancel(true)}>
            {t("cancel_order")}
          </button>
        ))}

      {RATABLE.includes(view.status) &&
        (rated ? (
          <div className="notice-ok">
            <Icon name="star" size={18} />
            {t("rate_thanks")}
          </div>
        ) : (
          <div className="card">
            <h3 className="section-title" style={{ marginTop: 0 }}>{t("rate_title")}</h3>
            <div className="star-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={n <= stars ? "star-btn star-btn--on" : "star-btn"}
                  aria-label={`${n} ${t("rate_stars")}`}
                  aria-pressed={n <= stars}
                  onClick={() => setStars(n)}
                >
                  <Icon name="star" size={26} />
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field-label">{t("rate_comment_label")}</span>
              <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">{t("dispute_phone_label")}</span>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="btn" disabled={stars < 1 || !phone} onClick={sendRating}>
              {t("rate_submit")}
            </button>
          </div>
        ))}

      {DISPUTABLE.includes(view.status) &&
        (disputeSent ? (
          <div className="notice-ok">
            <Icon name="check" size={18} />
            {t("dispute_success")}
          </div>
        ) : disputeOpen ? (
          <div className="card">
            <h3 className="section-title" style={{ marginTop: 0 }}>{t("dispute_open")}</h3>
            <label className="field">
              <span className="field-label">{t("dispute_reason_label")}</span>
              <textarea
                className="input"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">{t("dispute_phone_label")}</span>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <button className="btn" disabled={reason.length < 5 || !phone} onClick={sendDispute}>
              {t("dispute_submit")}
            </button>
          </div>
        ) : (
          <button className="btn-ghost" onClick={() => setDisputeOpen(true)}>
            {t("dispute_open")}
          </button>
        ))}

      <ol className="timeline">
        {view.history.map((h, i) => (
          <li key={i}>
            {statusLabel(h.status)}
            <time>{new Date(h.at).toLocaleTimeString()}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------- Seller space (S1) ---------------- */

const LAUNCH_COUNTRIES = ["SN", "CI", "BF", "ML", "BJ", "TG", "NE"];

/** Stable per-browser device hash for OTP device binding (DC-8.3). */
function deviceHash(): string {
  let h = localStorage.getItem("device_hash");
  if (!h) {
    h = crypto.randomUUID();
    localStorage.setItem("device_hash", h);
  }
  return h;
}

interface SellerProduct {
  id: string;
  title: string;
  price: MoneyWire;
  stock: number;
  status: string;
}

interface SellerShop {
  id: string;
  name: string;
  slug: string;
  verified: boolean;
  country: string;
  enabled_methods: string[];
  products: SellerProduct[];
}

interface SellerOrderRow {
  id: string;
  status: string;
  total: MoneyWire;
  created_at: string;
}

function productStatusLabel(s: string): string {
  if (s === "active") return t("pstatus_active");
  if (s === "draft") return t("pstatus_draft");
  if (s === "archived") return t("pstatus_archived");
  return s;
}

function SellerSpace() {
  const [stage, setStage] = useState<"login" | "code" | "loading" | "create" | "dash">(
    getAccessToken() ? "loading" : "login"
  );
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("SN");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [shop, setShop] = useState<SellerShop | null>(null);

  const load = useCallback(async () => {
    setStage("loading");
    setError(null);
    try {
      const s = await api<SellerShop>("/me/shop");
      setShop(s);
      setStage("dash");
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 404 || err.status === 403) {
        setStage("create"); // logged in, no shop (or no seller role yet)
      } else {
        clearTokens();
        setStage("login");
        if (err.status !== 401) setError(err.message);
      }
    }
  }, []);

  useEffect(() => {
    if (getAccessToken()) void load();
  }, [load]);

  const requestOtp = useCallback(async () => {
    setError(null);
    try {
      await api("/auth/otp", {
        method: "POST",
        body: JSON.stringify({ phone, country, device_hash: deviceHash() })
      });
      setInfo(t("otp_sent"));
      setStage("code");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [phone, country]);

  const verifyOtp = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ access_token: string; refresh_token: string }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ phone, code, device_hash: deviceHash() })
      });
      setTokens(r.access_token, r.refresh_token);
      setInfo(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [phone, code, load]);

  const logout = useCallback(() => {
    clearTokens();
    setShop(null);
    setStage("login");
  }, []);

  if (stage === "loading") return <p className="muted">{t("loading")}</p>;

  if (stage === "login" || stage === "code") {
    return (
      <div>
        <h2>{t("seller_login_title")}</h2>
        <p className="muted" style={{ fontSize: "0.9375rem" }}>{t("seller_login_hint")}</p>
        {info && <div className="notice-ok">{info}</div>}
        {error && <div className="notice-warn">{error}</div>}
        {stage === "login" ? (
          <>
            <label className="field">
              <span className="field-label">{t("phone_label")}</span>
              <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">{t("country_label")}</span>
              <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                {LAUNCH_COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" disabled={!phone} onClick={requestOtp}>
              {t("otp_request")}
            </button>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">{t("otp_code_label")}</span>
              <input
                className="input num"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button className="btn" disabled={code.length !== 6} onClick={verifyOtp}>
              {t("otp_verify")}
            </button>
            <div className="gap" />
            <button className="btn-ghost" onClick={requestOtp}>
              {t("ussd_resend")}
            </button>
          </>
        )}
      </div>
    );
  }

  if (stage === "create") return <CreateShop onDone={load} onLogout={logout} />;

  return shop ? <SellerDashboard shop={shop} onReload={load} onLogout={logout} /> : null;
}

function CreateShop({ onDone, onLogout }: { onDone: () => Promise<void>; onLogout: () => void }) {
  const [cities, setCities] = useState<Array<{ id: string; name: string; country: string }>>([]);
  const [name, setName] = useState("");
  const [cityId, setCityId] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ cities: Array<{ id: string; name: string; country: string }> }>("/cities")
      .then((r) => {
        setCities(r.cities);
        if (r.cities[0]) setCityId(r.cities[0].id);
      })
      .catch(() => setCities([]));
  }, []);

  const submit = useCallback(async () => {
    const city = cities.find((c) => c.id === cityId);
    if (!city || name.length < 2) return;
    setError(null);
    try {
      await api("/shops", {
        method: "POST",
        body: JSON.stringify({
          name,
          country: city.country,
          city_id: city.id,
          ...(whatsapp ? { whatsapp_phone: whatsapp } : {})
        })
      });
      await refreshTokens(); // pick up the freshly granted seller role
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cities, cityId, name, whatsapp, onDone]);

  return (
    <div>
      <h2>{t("create_shop_title")}</h2>
      {error && <div className="notice-warn">{error}</div>}
      <label className="field">
        <span className="field-label">{t("shop_name_label")}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">{t("shop_city_label")}</span>
        <select className="input" value={cityId} onChange={(e) => setCityId(e.target.value)}>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.country})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{t("shop_whatsapp_label")}</span>
        <input className="input" type="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
      </label>
      <button className="btn" disabled={name.length < 2 || !cityId} onClick={submit}>
        {t("shop_create_submit")}
      </button>
      <div className="gap" />
      <button className="btn-ghost" onClick={onLogout}>
        {t("logout")}
      </button>
    </div>
  );
}

function SellerDashboard({
  shop,
  onReload,
  onLogout
}: {
  shop: SellerShop;
  onReload: () => Promise<void>;
  onLogout: () => void;
}) {
  const [orders, setOrders] = useState<SellerOrderRow[] | null>(null);
  const [balance, setBalance] = useState<{ available: MoneyWire } | null>(null);
  const [title, setTitle] = useState("");
  const [priceFcfa, setPriceFcfa] = useState("");
  const [stock, setStock] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [pin, setPin] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const authGuard = useCallback(
    (e: unknown) => {
      if ((e as { status?: number }).status === 401) {
        clearTokens();
        void onReload(); // lands back on the login stage
        return true;
      }
      return false;
    },
    [onReload]
  );

  const loadBalance = useCallback(() => {
    api<{ available: MoneyWire }>("/balance").then(setBalance).catch((e) => {
      if (!authGuard(e)) setBalance(null);
    });
  }, [authGuard]);

  useEffect(() => {
    api<SellerOrderRow[]>(`/shops/${shop.id}/orders`).then(setOrders).catch((e) => {
      if (!authGuard(e)) setOrders([]);
    });
    loadBalance();
  }, [shop.id, loadBalance, authGuard]);

  const addProduct = useCallback(async () => {
    if (title.length < 2 || !/^\d+$/.test(priceFcfa) || !/^\d+$/.test(stock)) return;
    setNotice(null);
    try {
      // XOF has no minor subdivision here: displayed FCFA == amount_minor
      // (formatMoney renders amount_minor 1:1) — the inverse is the identity.
      await api(`/shops/${shop.id}/products`, {
        method: "POST",
        body: JSON.stringify({
          title,
          price: { amount_minor: BigInt(priceFcfa).toString(), currency: "XOF" },
          stock: Number(stock),
          image_keys: []
        })
      });
      setTitle("");
      setPriceFcfa("");
      setStock("");
      await onReload();
    } catch (e) {
      if (!authGuard(e)) setNotice({ ok: false, text: (e as Error).message });
    }
  }, [shop.id, title, priceFcfa, stock, onReload, authGuard]);

  const requestPayout = useCallback(async () => {
    if (!/^\d+$/.test(payAmount)) return;
    setNotice(null);
    try {
      await api("/payouts", {
        method: "POST",
        body: JSON.stringify({
          amount: { amount_minor: BigInt(payAmount).toString(), currency: "XOF" },
          ...(pin ? { payout_pin: pin } : {}),
          idempotency_key: crypto.randomUUID()
        })
      });
      setNotice({ ok: true, text: t("payout_success") });
      setPayAmount("");
      loadBalance();
    } catch (e) {
      if (authGuard(e)) return;
      const code = (e as { code?: string }).code;
      if (code === "insufficient_balance") setNotice({ ok: false, text: t("payout_insufficient") });
      else if (code === "rail_down") setNotice({ ok: false, text: t("payout_rail_down") });
      else if (code === "pin_required") setNotice({ ok: false, text: t("payout_pin_required") });
      else setNotice({ ok: false, text: (e as Error).message });
    }
  }, [payAmount, pin, loadBalance, authGuard]);

  return (
    <div>
      <section className="trust">
        <div className="trust-shop">
          <span>{shop.name}</span>
          {shop.verified && (
            <span className="trust-badge">
              <Icon name="shield" size={16} />
              {t("verified_seller")}
            </span>
          )}
        </div>
        <div className="trust-stat">{t("seller_space")}</div>
      </section>
      {notice && <div className={notice.ok ? "notice-ok" : "notice-warn"}>{notice.text}</div>}

      <h3 className="section-title">{t("balance_title")}</h3>
      <div className="card">
        <div className="product-meta" style={{ marginTop: 0 }}>
          <span>{t("balance_available")}</span>
          <strong className="price">{formatMoney(balance?.available ?? null)}</strong>
        </div>
        <div className="gap" />
        <label className="field">
          <span className="field-label">{t("payout_amount_label")}</span>
          <input className="input num" inputMode="numeric" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("payout_pin_label")}</span>
          <input className="input num" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        <button className="btn-ghost" disabled={!/^\d+$/.test(payAmount)} onClick={requestPayout}>
          {t("payout_request")}
        </button>
      </div>

      <h3 className="section-title">{t("my_products")}</h3>
      <div className="card">
        {shop.products.length === 0 && <p className="muted">{t("no_products")}</p>}
        {shop.products.map((p) => (
          <div key={p.id} className="list-row">
            <span className="list-main">{p.title}</span>
            <span className="price">{formatMoney(p.price)}</span>
            <span className="chip-stock num">{p.stock}</span>
            <span className={p.status === "active" ? "chip-stock" : "chip-stock chip-stock--muted"}>
              {productStatusLabel(p.status)}
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3 className="section-title" style={{ marginTop: 0 }}>{t("add_product")}</h3>
        <label className="field">
          <span className="field-label">{t("product_title_label")}</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("product_price_label")}</span>
          <input className="input num" inputMode="numeric" value={priceFcfa} onChange={(e) => setPriceFcfa(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("product_stock_label")}</span>
          <input className="input num" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} />
        </label>
        <button className="btn" disabled={title.length < 2 || !/^\d+$/.test(priceFcfa) || !/^\d+$/.test(stock)} onClick={addProduct}>
          {t("product_submit")}
        </button>
      </div>

      <h3 className="section-title">{t("orders_inbox")}</h3>
      <div className="card">
        {orders === null && <p className="muted">{t("loading")}</p>}
        {orders?.length === 0 && <p className="muted">{t("no_orders")}</p>}
        {orders?.map((o) => (
          <div key={o.id} className="list-row">
            <span className="list-main num">#{o.id.slice(0, 8)}</span>
            <span className="chip-stock">{statusLabel(o.status)}</span>
            <span className="price">{formatMoney(o.total)}</span>
          </div>
        ))}
      </div>

      <button className="btn-ghost" onClick={onLogout}>
        {t("logout")}
      </button>
    </div>
  );
}
