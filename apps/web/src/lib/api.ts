/** Thin API client. Money stays in wire format; formatting via shared. */

export interface MoneyWire {
  amount_minor: string;
  currency: string;
}

export function formatMoney(m: MoneyWire | null): string {
  if (!m) return "—";
  const n = BigInt(m.amount_minor);
  const grouped = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return m.currency === "XOF" ? `${grouped} FCFA` : `${grouped} ${m.currency}`;
}

const BASE = "/api";

/**
 * Seller-session token store (S1). Guest flows stay tokenless — the header is
 * only attached once a seller has logged in via OTP.
 */
const ACCESS_KEY = "auth_access";
const REFRESH_KEY = "auth_refresh";

export function getAccessToken(): string | null {
  try {
    return localStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

/** Rotate the pair (also refreshes roles in the access token, e.g. after first shop). */
export async function refreshTokens(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const r = await api<{ access_token: string; refresh_token: string }>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refresh })
    });
    setTokens(r.access_token, r.refresh_token);
    return true;
  } catch {
    clearTokens();
    return false;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw Object.assign(new Error(body.message ?? `HTTP ${res.status}`), {
      code: body.code,
      status: res.status
    });
  }
  return res.json() as Promise<T>;
}

export interface ProductView {
  id: string;
  shop_id: string;
  title: string;
  description: string | null;
  price: MoneyWire;
  stock: number;
  images: string[];
  shop?: { slug: string; name: string; verified: boolean; completed_orders?: number; whatsapp_phone?: string | null };
  share_url?: string;
}

export interface CheckoutMethod {
  method: string;
  label: string;
  ussd_confirm: boolean;
  ussd_dial_code: string | null;
  remembered_default: boolean;
  fee_display?: string;
}

export interface AttemptView {
  id: string;
  order_id: string;
  method: string;
  status: string;
  provider_code: string | null;
  ussd: { dial_code: string; expires_in_s: number; can_resend: boolean } | null;
  next_action: { kind: string; url?: string; qr_payload?: string; manual_reference?: string } | null;
  failure_reason: string | null;
}
