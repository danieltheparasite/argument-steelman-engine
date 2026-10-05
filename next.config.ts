import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  async rewrites() { return { beforeFiles: [{ source: "/", destination: "/desk.html" }], afterFiles: [], fallback: [] }; },
};
export default nextConfig;
