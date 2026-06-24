import { closeDb, getDb, migrate } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { userStore } from "../src/lib/userstore";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found?.slice(prefix.length);
}

async function main() {
  const email = arg("email") || process.env.BUTLER_ADMIN_EMAIL;
  const password = arg("password") || process.env.BUTLER_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("Set BUTLER_ADMIN_EMAIL/BUTLER_ADMIN_PASSWORD or pass --email=... --password=...");
  }

  await migrate(getDb());
  const user = await userStore.ensureAdminUser(email, hashPassword(password));
  process.stdout.write(`Admin ready: ${user.email} (id ${user.id})\n`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
