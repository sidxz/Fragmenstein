import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Proxy API requests to backend in development
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_URL || "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
