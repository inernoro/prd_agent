#!/usr/bin/env python3
"""KD-13 isolated migration rehearsal. Requires pymongo. Never connects to production.
Default is audit. --apply is allowed only for a loopback kd13_* database.
Output contains counts only; no passwords, hashes, tokens or document IDs.
"""
import argparse
import base64
import hashlib
import hmac
import os
from urllib.parse import urlsplit


def verifier(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100000, 32)


def plan(row):
    password = row.get('Password')
    if password is None:
        return None
    if not isinstance(password, str) or not password:
        raise ValueError('invalid legacy password')
    encoded_hash, encoded_salt = row.get('PasswordHash'), row.get('PasswordSalt')
    if bool(encoded_hash) != bool(encoded_salt):
        raise ValueError('partial verifier')
    if encoded_hash:
        salt = base64.b64decode(encoded_salt, validate=True)
        hashed = base64.b64decode(encoded_hash, validate=True)
        if len(salt) != 16 or len(hashed) != 32 or not hmac.compare_digest(verifier(password, salt), hashed):
            raise ValueError('verifier mismatch')
    else:
        salt = os.urandom(16)
        encoded_salt = base64.b64encode(salt).decode()
        encoded_hash = base64.b64encode(verifier(password, salt)).decode()
    # Include observed credential fields: a concurrent reset must win over migration.
    predicate = {'_id': row['_id']}
    for key in ('Password', 'PasswordHash', 'PasswordSalt'):
        predicate[key] = row[key] if key in row else {'$exists': False}
    return predicate, {'$set': {'PasswordHash': encoded_hash, 'PasswordSalt': encoded_salt}, '$unset': {'Password': ''}}


def migrate(collection, apply=False):
    counts = dict(scanned=0, eligible=0, migrated=0, conflicts=0, invalid=0)
    for row in collection.find({'Password': {'$type': 'string'}}):
        counts['scanned'] += 1
        try:
            change = plan(row)
        except (ValueError, TypeError):
            counts['invalid'] += 1
            continue
        if change:
            counts['eligible'] += 1
            if apply:
                result = collection.update_one(*change)
                counts['migrated' if result.modified_count else 'conflicts'] += 1
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uri', default='mongodb://127.0.0.1:27083')
    parser.add_argument('--database', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    url = urlsplit(args.uri)
    if url.scheme != 'mongodb' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.query or not args.database.startswith('kd13_'):
        parser.error('Only loopback kd13_* rehearsal databases are permitted')
    from pymongo import MongoClient
    import json
    with MongoClient(args.uri, serverSelectionTimeoutMS=5000) as client:
        print(json.dumps(migrate(client[args.database].web_page_share_links, args.apply)))


if __name__ == '__main__':
    main()
