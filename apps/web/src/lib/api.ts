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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init
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
