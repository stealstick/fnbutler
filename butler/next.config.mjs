import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: __dirname,
  // better-sqlite3 is a native module — keep it out of the bundler so route
  // handlers / server components can `require` it at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
