import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export for FastAPI hosting on Databricks Apps
  output: 'export',
  // Disable features not supported in static export
  images: {
    unoptimized: true,
  },
  // Trailing slash for proper static file routing
  trailingSlash: true,
};

export default nextConfig;
