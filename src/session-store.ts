import session from 'express-session';
import { cpaDb } from './db.js';

type SessionRow = {
  sid: string;
  expires_at: Date | string | null;
  data: string;
};

export class KnexSessionStore extends session.Store {
  private readonly tableName = 'app_sessions';

  get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void) {
    cpaDb<SessionRow>(this.tableName)
      .where({ sid })
      .first()
      .then(row => {
        if (!row) return callback(null, null);
        if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
          this.destroy(sid, () => callback(null, null));
          return;
        }
        callback(null, JSON.parse(row.data));
      })
      .catch(callback);
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void) {
    const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 12 * 60 * 60 * 1000);
    const payload = {
      sid,
      expires_at: expiresAt,
      data: JSON.stringify(sess),
      updated_at: cpaDb.fn.now(),
    };

    cpaDb(this.tableName)
      .insert({ ...payload, created_at: cpaDb.fn.now() })
      .onConflict('sid')
      .merge(payload)
      .then(() => callback?.())
      .catch(err => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void) {
    cpaDb(this.tableName)
      .where({ sid })
      .delete()
      .then(() => callback?.())
      .catch(err => callback?.(err));
  }

  touch(sid: string, sess: session.SessionData, callback?: (err?: unknown) => void) {
    const expiresAt = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 12 * 60 * 60 * 1000);
    cpaDb(this.tableName)
      .where({ sid })
      .update({ expires_at: expiresAt, updated_at: cpaDb.fn.now() })
      .then(() => callback?.())
      .catch(err => callback?.(err));
  }
}
