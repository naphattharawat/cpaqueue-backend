import { Router, type Request } from 'express';
import { logLogin } from '../models/audit.model.js';
import { ensureCsrfToken, rateLimit } from '../security.js';
import { authenticateLdap } from '../services/ldap.service.js';

export const authRouter = Router();

authRouter.get('/me', (req, res) => {
  res.json({ status: 'success', data: req.session.user || null, csrfToken: req.session.csrfToken || null });
});

authRouter.post('/login', rateLimit({ keyPrefix: 'auth-login', windowMs: 60_000, max: 10 }), async (req, res, next) => {
  let user;
  try {
    user = await authenticateLdap(String(req.body.username || ''), String(req.body.password || ''));
  } catch (err) {
    console.warn('Login failed:', err instanceof Error ? err.message : err);
    logLogin({ username: String(req.body.username || ''), success: false, failureReason: err instanceof Error ? err.message : String(err), ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Login log failed:', logErr));
    return res.status(401).json({ status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  try {
    await regenerateSession(req);
    req.session.user = user;
    ensureCsrfToken(req, res);
    await saveSession(req);
    logLogin({ username: user.username, displayName: user.displayName, role: user.roles?.join(',') || '', success: true, ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Login log failed:', logErr));
    res.json({ status: 'success', data: user, csrfToken: req.session.csrfToken || null });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req, res) => {
  if (req.session.user) {
    logLogin({ username: req.session.user.username, displayName: req.session.user.displayName, role: req.session.user.roles?.join(',') || '', success: true, failureReason: 'logout', ip: req.ip, userAgent: req.get('user-agent') }).catch(logErr => console.warn('Logout log failed:', logErr));
  }
  req.session.destroy(() => {
    res.clearCookie(process.env.SESSION_COOKIE_NAME || 'cpaqueue.sid');
    res.json({ status: 'success' });
  });
});

function regenerateSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((err: unknown) => err ? reject(err) : resolve());
  });
}

function saveSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.save((err: unknown) => err ? reject(err) : resolve());
  });
}
