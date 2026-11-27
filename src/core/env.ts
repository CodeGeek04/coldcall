/** Loads ./.env into process.env if it exists. Values already set in the shell win. */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
