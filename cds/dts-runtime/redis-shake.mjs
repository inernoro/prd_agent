/** The adapter generates only a bounded append-only configuration for the original RedisShake executable. */
export const REDIS_SHAKE_VERSION = '4.7.0';
export function redisShakeConfig(job, directory) {
  if (job.cds_adapter !== 'redis-shake' || job.version !== REDIS_SHAKE_VERSION || !Array.isArray(job.entries) || job.entries.length > 10000) throw new Error('unsupported adapter contract');
  function endpoint(value) {
    const u = new URL(value);
    if (u.protocol !== 'redis:' || u.search || u.hash || !/^\/(?:[0-9]|1[0-5])$/.test(u.pathname)) throw new Error('unverified Redis endpoint');
    return { address:u.hostname+':'+(u.port||'6379'),username:decodeURIComponent(u.username),password:decodeURIComponent(u.password),db:Number(u.pathname.slice(1)) };
  }
  const s=endpoint(job.sourceUri),t=endpoint(job.targetUri),q=JSON.stringify;
  const entries=job.entries.map(e=>{
    if(!/^[A-Za-z0-9_.:@-]{1,200}$/.test(e.key)||!Number.isSafeInteger(e.expireAt)||e.expireAt<0)throw new Error('invalid key selection');
    return '['+q(e.key)+']='+e.expireAt;
  }).join(',');
  // No REPLACE, no source AOF tail, no flush, and no individual-command fallback.
  const lua=`local expirations = {${entries}}\nif (CMD == "RESTORE" or CMD == "RESTORE-ASKING") and expirations[KEYS[1]] then\n shake.call(${t.db}, {"RESTORE", KEYS[1], tostring(expirations[KEYS[1]]), ARGV[4], "ABSTTL"})\nend`;
  return `[scan_reader]\naddress = ${q(s.address)}\nusername = ${q(s.username)}\npassword = ${q(s.password)}\ndbs = [${s.db}]\nscan = true\nksn = false\ncount = 100\n[redis_writer]\naddress = ${q(t.address)}\nusername = ${q(t.username)}\npassword = ${q(t.password)}\n[filter]\nallow_keys = ${q(job.entries.map(e=>e.key))}\nfunction = '''\n${lua}\n'''\n[advanced]\ndir = ${q(directory)}\nncpu = 1\nlog_file = ${q(directory+'/shake.log')}\nlog_level = "warn"\nrdb_restore_command_behavior = "skip"\npipeline_count_limit = 16\ntarget_redis_max_qps = 1000\ntarget_redis_proto_max_bulk_len = 67108864\nempty_db_before_sync = false\n`;
}
