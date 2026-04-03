/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['formidable', '@ffprobe-installer/ffprobe'],
  },
};

export default nextConfig;
