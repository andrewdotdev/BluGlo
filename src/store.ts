import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_FILE } from './config.js';
import type { AccountData, AccountsStore } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(__dirname, '..', DATA_FILE);
const dataDir = resolve(dataPath, '..');

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

export function readAccounts(): AccountsStore {
  if (!existsSync(dataPath)) return {};

  try {
    return JSON.parse(readFileSync(dataPath, 'utf8')) as AccountsStore;
  } catch {
    return {};
  }
}

export function writeAccounts(accounts: AccountsStore): void {
  writeFileSync(dataPath, JSON.stringify(accounts, null, 2), 'utf8');
}

export function upsertAccount(accountId: string, data: AccountData): void {
  const all = readAccounts();
  all[accountId] = data;
  writeAccounts(all);
}

export function deleteAccount(accountId: string): void {
  const all = readAccounts();
  delete all[accountId];
  writeAccounts(all);
}
