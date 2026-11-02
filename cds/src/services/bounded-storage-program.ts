/** Embedded in the source-free CDS artifact. Only fresh P formats; R is read-only.
 * No mount, detach, arbitrary command/path, sudo or privileged-container interface. */
export const BOUNDED_STORAGE_PROGRAM = String.raw`
import base64, fcntl, hashlib, json, os, re, stat, subprocess, sys

ROOT = '/var/lib/cds-bounded-task-logs-v1'
AUTHORITY = '/etc/cds/bounded-task-logs-v1.json'
BYTES, INODES, SLOTS = 134217728, 8192, 64
POLICY = 'xxl-task-logs-v1'
META = {'version': 1, 'policy': POLICY, 'bytes': BYTES, 'inodes': INODES, 'slots': SLOTS}

def require(value, why):
    if not value:
        raise RuntimeError('bounded_storage_unconfirmed:' + why)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def command(args):
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    require(p.returncode == 0 and len(p.stdout) <= 262144 and len(p.stderr) <= 262144, 'native-command')
    return p.stdout.decode().strip()

def validate_request(req):
    require(isinstance(req, dict) and set(req) == {'name','birthNonce','daemonId','binding','target'}, 'request-keys')
    b = req['binding']
    require(isinstance(b, dict) and set(b) == {'version','policy','purpose','instanceId','projectId','scope','branchId','serviceId','mountKey'}, 'binding-keys')
    require(type(b['version']) is int and b['version'] == 1 and b['policy'] == POLICY and b['purpose'] == 'persistent'
            and b['scope'] == 'branch-private' and b['mountKey'] == 'xxl-task-logs' and req['target'] == '/data/applogs/xxl-job', 'fixed-policy')
    for key in ('instanceId','projectId','branchId','serviceId','mountKey'):
        require(isinstance(b[key], str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', b[key]), 'binding-key')
    identity = [1,b['instanceId'],b['projectId'],b['scope'],b['branchId'],b['serviceId'],b['mountKey'],b['purpose']]
    name = 'cds-storage-v1-' + hashlib.sha256(json.dumps(identity,separators=(',', ':')).encode()).hexdigest()
    require(req['name'] == name and isinstance(req['birthNonce'],str) and re.fullmatch('[a-f0-9]{48}',req['birthNonce']), 'identity')
    require(isinstance(req['daemonId'],str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}',req['daemonId']), 'daemon-id')
    return req

def safe_dir(path):
    require(os.path.isabs(path), 'absolute-root')
    current = '/'
    for part in path.split('/')[1:]:
        current = os.path.join(current, part)
        s = os.lstat(current)
        require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and s.st_mode & 0o022 == 0, 'root-chain')
    return os.lstat(path)

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def read_record(path, limit=8192):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and s.st_mode & 0o022 == 0 and s.st_size <= limit, 'record-identity')
        return json.loads(os.read(fd, limit + 1))
    finally: os.close(fd)

def write_new(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        data = canonical(value)
        require(os.write(fd, data) == len(data), 'record-short-write')
        os.fsync(fd)
    finally: os.close(fd)
    sync_dir(os.path.dirname(path))

def authorize(req):
    safe_dir(os.path.dirname(AUTHORITY))
    authority = read_record(AUTHORITY, 262144)
    require(isinstance(authority,dict) and set(authority) == {'version','grants'} and authority['version'] == 1
            and isinstance(authority['grants'],list) and 0 < len(authority['grants']) <= 128, 'root-authority')
    expected = {k:req['binding'][k] for k in ('instanceId','projectId','scope','branchId','serviceId','mountKey')}
    expected['target'] = req['target']
    require(all(isinstance(g,dict) and set(g) == set(expected) and all(isinstance(v,str) for v in g.values()) for g in authority['grants'])
            and expected in authority['grants'], 'owner-not-authorized')

def host_filesystem(path):
    rows = json.loads(command(['findmnt','--json','--target',path,'--output','ID,MAJ:MIN,FSROOT,FSTYPE,SOURCE,TARGET'])).get('filesystems')
    require(isinstance(rows,list) and len(rows) == 1, 'host-filesystem-unknown')
    row = rows[0]
    # A preallocated file on tmpfs/overlay would spend RAM or a container layer.
    require(row.get('fstype') in ('ext4','xfs') and row.get('fsroot') == '/' and isinstance(row.get('source'),str)
            and row['source'].startswith('/dev/') and row.get('maj:min') == str(os.major(os.stat(path).st_dev))+':'+str(os.minor(os.stat(path).st_dev)), 'host-filesystem-not-disk')
    return row

def open_pool(create):
    safe_dir(os.path.dirname(ROOT))
    host = host_filesystem(os.path.dirname(ROOT))
    if create and not os.path.lexists(ROOT):
        os.mkdir(ROOT, 0o700)
        sync_dir(os.path.dirname(ROOT))
        write_new(ROOT + '/pool.json', {**META, 'host':host})
    s = safe_dir(ROOT)
    require(stat.S_IMODE(s.st_mode) == 0o700 and host_filesystem(ROOT) == host
            and read_record(ROOT + '/pool.json') == {**META, 'host':host}, 'pool-policy')
    fd = os.open(ROOT + '/pool.lock', os.O_RDWR | (os.O_CREAT if create else 0) | os.O_NOFOLLOW, 0o600)
    s = os.fstat(fd)
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600, 'pool-lock')
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd

def disk_identity(file):
    s = os.lstat(file)
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1 and stat.S_IMODE(s.st_mode) == 0o600
            and s.st_size == BYTES and s.st_blocks * 512 >= BYTES, 'backing-file')
    return {'device': s.st_dev, 'inode': s.st_ino}

def filesystem(file):
    metadata = dict(line.split('=',1) for line in command(['blkid','-p','-o','export',file]).splitlines() if '=' in line)
    require(metadata.get('TYPE') == 'ext4' and re.fullmatch(r'[a-f0-9-]{36}',metadata.get('UUID','')), 'filesystem-uuid')
    header = dict((k.strip(),v.strip()) for k,v in (line.split(':',1) for line in command(['dumpe2fs','-h',file]).splitlines() if ':' in line))
    total, inodes = int(header['Block count']) * int(header['Block size']), int(header['Inode count'])
    require(total == BYTES and 0 < inodes <= INODES, 'filesystem-quota')
    return {'uuid':metadata['UUID'], 'bytes':total, 'inodes':inodes}

def loop_identity(device, file, backing):
    require(isinstance(device,str) and re.fullmatch(r'/dev/loop[0-9]{1,6}', device), 'loop-path')
    s = os.lstat(device)
    require(stat.S_ISBLK(s.st_mode) and os.major(s.st_rdev) == 7, 'loop-device')
    records = json.loads(command(['losetup','--json','--list','--output','NAME,BACK-FILE,BACK-INO,BACK-MAJ:MIN,OFFSET,SIZELIMIT,AUTOCLEAR,RO',device])).get('loopdevices')
    require(isinstance(records,list) and len(records)==1, 'loop-record')
    row = records[0]
    require(row.get('name') == device and row.get('back-file') == file and row.get('back-ino') == backing['inode']
            and row.get('back-maj:min') == str(os.major(backing['device']))+':'+str(os.minor(backing['device']))
            and row.get('offset') == 0 and row.get('sizelimit') == 0 and row.get('autoclear') is False and row.get('ro') is False, 'loop-backing')
    require(int(command(['blockdev','--getsize64',device])) == BYTES, 'loop-size')
    return {'path':device, 'rdev':s.st_rdev}

def inspect(req):
    directory = ROOT + '/' + req['name']
    safe_dir(directory)
    require(read_record(directory + '/intent.json') == req, 'intent-mismatch')
    receipt = read_record(directory + '/receipt.json')
    require(set(receipt) == {'version','request','backing','filesystem','loop'} and receipt['version'] == 1 and receipt['request'] == req, 'receipt-mismatch')
    file = directory + '/disk.img'
    require(disk_identity(file) == receipt['backing'] and filesystem(file) == receipt['filesystem'], 'original-filesystem')
    require(loop_identity(receipt['loop']['path'], file, receipt['backing']) == receipt['loop'], 'original-device')
    return {'version':1,'device':receipt['loop']['path'],'receiptSha256':hashlib.sha256(canonical(receipt)).hexdigest(),
            'bytes':receipt['filesystem']['bytes'],'inodes':receipt['filesystem']['inodes'],'uuid':receipt['filesystem']['uuid']}

def create(req):
    entries = os.listdir(ROOT)
    names = [name for name in entries if re.fullmatch('cds-storage-v1-[a-f0-9]{64}', name)]
    require(len(names) < SLOTS and set(entries) == set(names) | {'pool.json','pool.lock'}, 'pool-reservations')
    directory = ROOT + '/' + req['name']
    require(not os.path.lexists(directory), 'fresh-only')
    free = os.statvfs(ROOT)
    require(free.f_bavail * free.f_frsize >= BYTES + 67108864 and free.f_favail >= INODES + 32, 'host-free')
    os.mkdir(directory, 0o700)
    sync_dir(ROOT)
    write_new(directory + '/intent.json', req)
    file = directory + '/disk.img'
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.posix_fallocate(fd, 0, BYTES)
        os.fsync(fd)
    finally: os.close(fd)
    sync_dir(directory)
    backing = disk_identity(file)
    # Only the exclusive, preallocated, journaled inode just created above.
    command(['mkfs.ext4','-q','-F','-m','0','-b','4096','-N',str(INODES),'-E','nodiscard,lazy_itable_init=0,lazy_journal_init=0',file])
    require(disk_identity(file) == backing, 'fresh-inode-changed')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
    fs = filesystem(file)
    # Intent exists before the sole device-allocation command. Unknown outcomes hold.
    device = command(['losetup','--find','--show','--nooverlap',file])
    loop = loop_identity(device, file, backing)
    write_new(directory + '/receipt.json', {'version':1,'request':req,'backing':backing,'filesystem':fs,'loop':loop})
    return inspect(req)

def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ('create','inspect'), 'operation')
    require(len(sys.argv[2]) <= 8192, 'request-size')
    req = validate_request(json.loads(base64.b64decode(sys.argv[2],validate=True)))
    require(os.geteuid() == 0, 'root-provider-required')
    authorize(req)
    require(command(['docker','info','--format','{{.ID}}']) == req['daemonId'], 'daemon-changed')
    fd = open_pool(sys.argv[1] == 'create')
    try:
        result = create(req) if sys.argv[1] == 'create' else inspect(req)
        require(command(['docker','info','--format','{{.ID}}']) == req['daemonId'], 'daemon-changed')
        print(json.dumps(result,sort_keys=True))
    finally: os.close(fd)

if __name__ == '__main__':
    main()
`;
