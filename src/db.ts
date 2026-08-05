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
