import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.user) return next();
  res.status(401).json({ status: 'error', message: 'Unauthorized' });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.session.user?.roles.includes('admin')) return next();
  res.status(req.session.user ? 403 : 401).json({ status: 'error', message: req.session.user ? 'Forbidden' : 'Unauthorized' });
}
