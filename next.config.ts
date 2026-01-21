import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Databricks Apps configuration
  output: 'standalone', // Optimized for deployment
  compress: true,
  poweredByHeader: false,
};

export default nextConfig;
