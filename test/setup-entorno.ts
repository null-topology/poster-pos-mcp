// Runs before every test file. The offline suite must give the same results whatever runtime
// configuration a developer has exported in the shell (a local .env is already skipped under Vitest by
// src/config.ts), so those variables are removed here. Deleted, not stubbed: a test's own
// vi.unstubAllEnvs() would otherwise bring the exported values back. The live suite (POSTER_LIVE=1)
// keeps them. WRITE_DEFAULT_ACCOUNTS is pinned by vitest.config.ts.
const CONFIGURACION = [
  "POSTER_ACCOUNTS",
  "DEFAULT_WRITE_ACCOUNT",
  "TIMEZONE",
  "OWNER_NAME",
  "NETWORK_NAME",
  "SERVICE_NAME",
  "OAUTH_SUBJECT",
  "TOKEN_SOURCE",
  "POSTER_MYSQL_URL",
  "EXPERIMENTAL_WRITE_PROBE",
];

if (process.env.POSTER_LIVE !== "1") for (const k of CONFIGURACION) delete process.env[k];
