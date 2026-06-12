/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module — keep it out of the bundler so route
  // handlers / server components can `require` it at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
