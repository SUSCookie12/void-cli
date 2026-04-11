// Void DNS Configuration
// These should be loaded from environment variables or a secure vault
export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
export const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';
export const VOID_DOMAIN = process.env.VOID_DOMAIN || 'void.cspack.online';
