import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

export interface CdsPasskey {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  createdAt: string;
}

export interface CdsPasskeyStore {
  find(id: string): Promise<CdsPasskey | null>;
  list(userId: string): Promise<CdsPasskey[]>;
  insert(key: CdsPasskey): Promise<void>;
  advanceCounter(id: string, previous: number, next: number): Promise<boolean>;
}
