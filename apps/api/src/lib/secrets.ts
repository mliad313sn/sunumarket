/**
 * Production secrets assertion (pass-2 fix 8, NFR-3).
 *
 * Every signing secret has a dev default so `pnpm dev` works with zero setup
 * (mock-first, Playbook 0.5) — but a production process silently running on
 * `dev-secret-change-me` would sign real JWTs and accept forged webhooks.
 * At app build time in production, refuse to start unless every secret is set
 * AND differs from its dev default, naming the offenders.
 */
const REQUIRED_SECRETS: ReadonlyArray<{ name: string; devDefault: string }> = [
  { name: "JWT_SECRET", devDefault: "dev-secret-change-me" },
  { name: "MOCK_AGG_A_SECRET", devDefault: "agg-a-secret" },
  { name: "MOCK_AGG_B_SECRET", devDefault: "agg-b-secret" },
  { name: "MOCK_PISPI_SECRET", devDefault: "pispi-secret" },
  { name: "PARTNER_DIALOG_WEBHOOK_SECRET", devDefault: "partner-secret" }
];

export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const offending = REQUIRED_SECRETS.filter(({ name, devDefault }) => {
    const v = env[name];
    return !v || v === devDefault;
  }).map((s) => s.name);
  if (offending.length > 0) {
    throw new Error(
      `refus de démarrage en production — secrets manquants ou encore aux valeurs de dev: ${offending.join(", ")}. ` +
        `Définissez de vraies valeurs d'environnement pour ces variables.`
    );
  }
}
