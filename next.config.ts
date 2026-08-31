import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "assets.woolworths.com.au",
        pathname: "/images/**",
      },
    ],
  },
};

export default nextConfig;
