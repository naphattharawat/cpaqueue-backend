import 'dotenv/config';
import knex from 'knex';

export const hospitalDb = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  },
});

export const pharmacyDb = process.env.PHARMACY_DB_ENABLED === 'true'
  ? knex({
      client: 'pg',
      connection: {
        host: process.env.PHARMACY_PGHOST,
        port: Number(process.env.PHARMACY_PGPORT || 5432),
        database: process.env.PHARMACY_PGDATABASE,
        user: process.env.PHARMACY_PGUSER,
        password: process.env.PHARMACY_PGPASSWORD,
        ssl: process.env.PHARMACY_PGSSL === 'true'
          ? { rejectUnauthorized: process.env.PHARMACY_PGSSL_REJECT_UNAUTHORIZED === 'true' }
          : undefined,
        connectionTimeoutMillis: Number(process.env.PHARMACY_DB_TIMEOUT_MS || 3000),
      },
      pool: {
        min: 0,
        max: 5,
        acquireTimeoutMillis: Number(process.env.PHARMACY_DB_TIMEOUT_MS || 3000),
      },
      acquireConnectionTimeout: Number(process.env.PHARMACY_DB_TIMEOUT_MS || 3000),
    })
  : null;

export const cpaDb = knex({
  client: 'mysql2',
  connection: {
    host: process.env.MYSQL_HOST,
    database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    charset: 'utf8',
  },
  pool: {
    min: 0,
    max: 10,
  },
});
