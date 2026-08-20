/** i18n FR-first with EN toggle (FR-46). No hardcoded strings in views — lint-tested. */

export type Locale = "fr" | "en";

const fr = {
  app_title: "SunuMarket",
  tagline: "Vendez sur les réseaux, encaissez en toute confiance.",
  marketplace: "Marché",
  search_placeholder: "Rechercher un produit…",
  empty_marketplace: "Aucun produit trouvé.",
  add_to_cart: "Commander",
  price: "Prix",
  stock_left: "En stock",
  out_of_stock: "Rupture de stock",
  verified_seller: "Vendeur vérifié",
  completed_orders: "commandes livrées",
  call_seller: "Appeler",
  whatsapp_seller: "WhatsApp",
  checkout_title: "Paiement",
  delivery_point: "Point de livraison",
  landmark_label: "Repère (obligatoire) — ex. « en face de la pharmacie »",
  landmark_required: "Ajoutez un repère pour aider le livreur",
  use_gps: "📍 Utiliser ma position GPS",
  gps_saved_offline: "Position enregistrée — sera envoyée dès que le réseau revient",
  phone_label: "Votre numéro de téléphone",
  consent_label: "J'accepte que ma position soit utilisée pour la livraison",
  delivery_fee: "Frais de livraison",
  out_of_zone: "Zone non desservie — contactez le vendeur",
  total: "Total",
  choose_method: "Choisissez votre moyen de paiement",
  first_payment_hint: "Premier paiement ? Suivez les étapes — c'est simple et sécurisé.",
  remembered_method: "Votre méthode habituelle",
  pay_now: "Payer maintenant",
  ussd_title: "Confirmez sur votre téléphone",
  ussd_body: "Vous allez recevoir une demande de confirmation sur votre téléphone.",
  ussd_dial_hint: "Pas de notification ? Composez",
  ussd_countdown: "Temps restant",
  ussd_resend: "Renvoyer la demande",
  ussd_switch: "Changer de méthode",
  payment_failed_balance: "Échec du paiement. Rechargez chez un agent puis réessayez — la commande reste réservée 30 min.",
  payment_outage: "Paiement momentanément indisponible — réessayez ou changez de méthode. Votre commande reste réservée.",
  paid_success: "PAYÉ ✓ — votre commande est confirmée",
  qr_title: "Scannez avec n'importe quelle application",
  qr_body: "Payez depuis n'importe quel portefeuille ou banque compatible PI-SPI.",
  cod_confirm: "Vous paierez à la livraison. Préparez le montant exact.",
  tracking_title: "Suivi de commande",
  order_status: "Statut",
  seconds: "s",
  offline_banner: "Hors ligne — vos actions seront synchronisées automatiquement.",
  data_saver: "Économie de données",
  language: "Language / Langue",
  retry: "Réessayer",
  loading: "Chargement…"
};

const en: Record<keyof typeof fr, string> = {
  app_title: "SunuMarket",
  tagline: "Sell on socials, get paid with confidence.",
  marketplace: "Marketplace",
  search_placeholder: "Search products…",
  empty_marketplace: "No products found.",
  add_to_cart: "Order",
  price: "Price",
  stock_left: "In stock",
  out_of_stock: "Out of stock",
  verified_seller: "Verified seller",
  completed_orders: "orders delivered",
  call_seller: "Call",
  whatsapp_seller: "WhatsApp",
  checkout_title: "Payment",
  delivery_point: "Delivery point",
  landmark_label: "Landmark (required) — e.g. “opposite the pharmacy”",
  landmark_required: "Add a landmark to help the rider",
  use_gps: "📍 Use my GPS position",
  gps_saved_offline: "Position saved — will sync when back online",
  phone_label: "Your phone number",
  consent_label: "I agree my location is used for delivery",
  delivery_fee: "Delivery fee",
  out_of_zone: "Area not served — contact the seller",
  total: "Total",
  choose_method: "Choose your payment method",
  first_payment_hint: "First payment? Follow the steps — simple and secure.",
  remembered_method: "Your usual method",
  pay_now: "Pay now",
  ussd_title: "Confirm on your phone",
  ussd_body: "You will receive a confirmation request on your phone.",
  ussd_dial_hint: "No notification? Dial",
  ussd_countdown: "Time left",
  ussd_resend: "Resend request",
  ussd_switch: "Switch method",
  payment_failed_balance: "Payment failed. Top up at an agent and retry — your order stays reserved for 30 min.",
  payment_outage: "Payments briefly unavailable — retry or switch method. Your order stays reserved.",
  paid_success: "PAID ✓ — your order is confirmed",
  qr_title: "Scan with any app",
  qr_body: "Pay from any PI-SPI-compatible wallet or bank.",
  cod_confirm: "You will pay on delivery. Prepare the exact amount.",
  tracking_title: "Order tracking",
  order_status: "Status",
  seconds: "s",
  offline_banner: "Offline — your actions will sync automatically.",
  data_saver: "Data saver",
  language: "Langue / Language",
  retry: "Retry",
  loading: "Loading…"
};

export type MessageKey = keyof typeof fr;

const DICTS: Record<Locale, Record<MessageKey, string>> = { fr, en };

let current: Locale = (typeof localStorage !== "undefined" && (localStorage.getItem("locale") as Locale)) || "fr";

export function setLocale(l: Locale): void {
  current = l;
  if (typeof localStorage !== "undefined") localStorage.setItem("locale", l);
}

export function getLocale(): Locale {
  return current;
}

export function t(key: MessageKey): string {
  return DICTS[current][key] ?? DICTS.fr[key] ?? key;
}

export function dictionaries(): Record<Locale, Record<MessageKey, string>> {
  return DICTS;
}
