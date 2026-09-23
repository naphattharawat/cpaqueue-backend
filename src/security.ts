import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';

const isProduction = process.env.NODE_ENV === 'production';

export function requireProductionConfig() {
  const missing: string[] = [];
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (sessionSecret.length < 32 || sessionSecret === 'change-this-session-secret') missing.push('SESSION_SECRET (minimum 32 characters)');
  if (isProduction && !process.env.CORS_ORIGIN) missing.push('CORS_ORIGIN');
  if (isProduction && process.env.SESSION_SECURE !== 'true') missing.push('SESSION_SECURE=true');
  if (isProduction && process.env.TRUST_PROXY !== 'true') missing.push('TRUST_PROXY=true');
  if (isProduction && process.env.LDAP_TLS_REJECT_UNAUTHORIZED === 'false') missing.push('LDAP_TLS_REJECT_UNAUTHORIZED=true');
  if (isProduction && !String(process.env.LDAP_URL || '').toLowerCase().startsWith('ldaps://')) missing.push('LDAP_URL must use ldaps://');
  // 'file://' is allowed as-is: it's the origin Electron sends when the packaged desktop
  // app loads its UI via win.loadFile() — there's no network transport to secure there.
  if (isProduction && corsOrigins().some(origin => origin !== 'file://' && !origin.startsWith('https://'))) missing.push('CORS_ORIGIN must contain HTTPS (or file://) origins only');
  if (missing.length) {
    throw new Error(`Missing required security config: ${missing.join(', ')}`);
  }
}

export function corsOrigins() {
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  if (!isProduction) return ['http://localhost:4200', 'http://127.0.0.1:4200'];
  return [];
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

type RateBucket = { count: number; resetAt: number };
const buckets = new Map<string, RateBucket>();

export function rateLimit(options: { windowMs: number; max: number; keyPrefix: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${options.keyPrefix}:${req.ip}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ status: 'error', message: 'Too many requests' });
    }
    next();
  };
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  ensureCsrfToken(req, res);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/login' && req.baseUrl === '/auth') return next();
  if (req.path === '/display-devices/runtime/status' && req.baseUrl === '/api') return next();
  if (req.path === '/display-devices/setup-code/claim' && req.baseUrl === '/api') return next();
  const header = String(req.get('x-csrf-token') || '');
  if (!header || header !== req.session.csrfToken) {
    return res.status(403).json({ status: 'error', message: 'Invalid CSRF token' });
  }
  next();
}

export function ensureCsrfToken(req: Request, res: Response) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie('cpaqueue.csrf', req.session.csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.SESSION_SECURE === 'true',
    maxAge: Number(process.env.SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000),
  });
}
