import mysql from 'mysql2/promise';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { isPreviewInstance } from './preview-instance.js';

export interface DatabasePassTarget {
  runtime: 'mysql' | 'postgres' | 'mongodb';
  port: number;
  database: string;
  adminUser: string;
  adminPassword: string;
  mysqlCa?: string;
}
export interface DatabasePassAccount { username: string; password: string }
const ident = (v: string) => '"' + v.replaceAll('"', '""') + '"';

/** Every pass owns a fresh, unprivileged account; no existing application credential is exported. */
export async function changeDatabasePassAccount(target: DatabasePassTarget, account: DatabasePassAccount, create: boolean): Promise<void> {
  if(isPreviewInstance())throw new Error('隔离预览不签发或管理真实数据库账号');
  if (!/^cdsp_[a-f0-9]{20}$/.test(account.username)) throw new Error('临时账号标识无效');
  if (!target.port || !target.database || !target.adminUser || typeof target.adminPassword!=='string') throw new Error('资源缺少临时账号管理配置');
  if (target.runtime === 'mysql') {
    if(create && !target.mysqlCa)throw new Error('MySQL尚未提供TLS CA证书，不能签发直连通行证');
    // The target is fixed to loopback. Verify its configured CA, matching mysql --ssl-mode=VERIFY_CA;
    // auto-generated MySQL certificates need not contain 127.0.0.1. Never disable CA verification.
    const db = await mysql.createConnection({ host: '127.0.0.1', port: target.port, user: target.adminUser, password: target.adminPassword, connectTimeout: 5000, ...(target.mysqlCa?{ssl:{ca:target.mysqlCa,rejectUnauthorized:true,verifyIdentity:false}}:{}) });
    try {
      if (create) {
        await db.query('CREATE USER ?@\'%\' IDENTIFIED BY ? REQUIRE SSL WITH MAX_USER_CONNECTIONS 10', [account.username, account.password]);
        try { await db.query('GRANT SELECT ON ' + '`' + target.database.replaceAll('`','``') + '`.* TO ?@\'%\'', [account.username]); }
        catch (error) { await db.query('DROP USER IF EXISTS ?@\'%\'', [account.username]); throw error; }
      } else {
        // Revoke login first; killing only this generated account never touches application sessions.
        await db.query('DROP USER IF EXISTS ?@\'%\'', [account.username]);
        const [sessions] = await db.query<any[]>('SELECT ID FROM information_schema.PROCESSLIST WHERE USER=?', [account.username]);
        for (const session of sessions) await db.query('KILL CONNECTION ' + Number(session.ID));
      }
    } finally { await db.end(); }
    return;
  }
  if (target.runtime === 'postgres') {
    const db = new pg.Client({ host: '127.0.0.1', port: target.port, database: target.database, user: target.adminUser, password: target.adminPassword, connectionTimeoutMillis: 5000 });
    try{await db.connect();}catch(error){await db.end().catch(()=>{});throw error;}
    try {
      if (create) {
        // PUBLIC EXECUTE on SECURITY DEFINER functions can evade ordinary SELECT grants.
        const unsafe = await db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema') UNION ALL SELECT 1 FROM pg_class WHERE relkind='f' LIMIT 1");
        if (unsafe.rowCount) throw new Error('此库含提权执行函数，需要管理员整理权限后才能签发只读通行证');
        const escapedPassword = await db.query('SELECT quote_literal($1) AS value', [account.password]);
        await db.query(`CREATE ROLE ${ident(account.username)} LOGIN PASSWORD ${escapedPassword.rows[0].value} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 10`);
        try {
          const publicWrite=await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' AND has_schema_privilege($1,oid,'CREATE') UNION ALL SELECT 1 WHERE has_database_privilege($1,current_database(),'CREATE') LIMIT 1",[account.username]);
          if(publicWrite.rowCount)throw new Error('数据库PUBLIC权限允许写入，不能签发隔离只读账号');
          await db.query(`GRANT CONNECT ON DATABASE ${ident(target.database)} TO ${ident(account.username)}`);
          const schemas = await db.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'");
          for (const row of schemas.rows) {
            await db.query(`GRANT USAGE ON SCHEMA ${ident(row.nspname)} TO ${ident(account.username)}`);
            await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(row.nspname)} TO ${ident(account.username)}`);
          }
          await db.query(`ALTER ROLE ${ident(account.username)} SET default_transaction_read_only=on`);
        } catch (error) {
          await db.query(`DROP OWNED BY ${ident(account.username)}`);
          await db.query(`DROP ROLE ${ident(account.username)}`);
          throw error;
        }
      } else {
        const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [account.username]);
        if (exists.rowCount) {
          await db.query(`ALTER ROLE ${ident(account.username)} NOLOGIN`);
          await db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1', [account.username]);
          await db.query(`DROP OWNED BY ${ident(account.username)}`);
          await db.query(`DROP ROLE ${ident(account.username)}`);
        }
      }
    } finally { await db.end(); }
    return;
  }
  const db = new MongoClient(`mongodb://127.0.0.1:${target.port}/?directConnection=true`, { auth: { username: target.adminUser, password: target.adminPassword }, authSource: 'admin', serverSelectionTimeoutMS: 5000 });
  try{await db.connect();}catch(error){await db.close().catch(()=>{});throw error;}
  try {
    if (create) {
      const config=await db.db('admin').command({getCmdLineOpts:1});
      if(config.parsed?.security?.authorization!=='enabled'&&!config.parsed?.security?.keyFile)throw new Error('MongoDB必须启用身份认证，才能签发只读通行证');
      await db.db(target.database).command({ createUser: account.username, pwd: account.password, roles: [{ role: 'read', db: target.database }] });
    } else {
      try { await db.db(target.database).command({ dropUser: account.username }); }
      catch (error) { if ((error as { code?: number }).code !== 11) throw error; }
      // The gateway closes both sockets before revocation. dropUser invalidates the account;
      // do not demand MongoDB's additional impersonate privilege just to kill named sessions.
    }
  } finally { await db.close(); }
}
