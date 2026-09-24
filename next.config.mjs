/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['formidable', '@ffprobe-installer/ffprobe'],
  },
  server: {
    port: Number(process.env.PORT) || 3000,
  },
};

export default nextConfig;
