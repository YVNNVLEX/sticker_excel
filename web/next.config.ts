import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/local-db/records": ["./default-db/orchestra_labels.db"],
    "/api/local-db/import": ["./default-db/orchestra_labels.db"],
  },
};

export default nextConfig;
