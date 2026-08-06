import 'express-session';

declare module 'express-session' {
  interface SessionData {
    user?: {
      username: string;
      displayName: string;
      cid: string;
      roles: string[];
    };
    csrfToken?: string;
  }
}
