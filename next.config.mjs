/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['formidable', '@ffprobe-installer/ffprobe'],
  },
  // 增加请求体大小限制以支持大文件上传
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default nextConfig;
