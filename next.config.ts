import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server output: the Docker image copies `.next/standalone`
  // and runs it with plain `node`, without installing dependencies again.
  output: 'standalone',
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.woolworths.com.au',
        pathname: '/images/**',
      },
      {
        protocol: 'https',
        hostname: 'a.fsimg.co.nz',
        pathname: '/prod/product/retail/fan/image/**',
      },
      {
        protocol: 'https',
        hostname: 'a.fsimg.co.nz',
        pathname: '/product/retail/fan/image/**',
      },
      {
        protocol: 'https',
        hostname: 'dtgxwmigmg3gc.cloudfront.net',
        pathname: '/imagery/assets/derivations/**',
      },
      {
        protocol: 'https',
        hostname: 'upload.wikimedia.org',
        pathname: '/wikipedia/**',
      },
    ],
  },
};

export default nextConfig;
