import type { NextConfig } from 'next'

const config: NextConfig = {
  // standalone output is required for Docker image builds (Linux/CI only).
  // Omit it for local dev on Windows where symlink creation is restricted.
  ...(process.env.CI ? { output: 'standalone' } : {}),
  // Allow the builder to make API calls to the Go control-plane
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.API_BASE_URL ?? 'http://localhost:8080'}/v1/:path*`,
      },
    ]
  },
  experimental: {
    // Server Actions are used for BFF operations
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
}

export default config
