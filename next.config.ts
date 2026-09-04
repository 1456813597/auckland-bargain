import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
        hostname: '*.public.blob.vercel-storage.com',
        pathname: '/product-images/**',
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
