/**
 * TokenStore — Per-device WebDAV access tokens.
 *
 * Tokens are minted from the OIDC-protected dashboard and used as the
 * basic-auth password by WebDAV clients (Plex, Finder, etc.). The plaintext
 * is shown to the user once at creation time; only sha256 hashes are
 * persisted. The matching WsgiDAV DomainController
 * (`docker/webdav_token_controller.py`) reads the same JSON file fresh on
 * every auth request, so revocation is immediate.
 *
 * Tokens identify a *device*, not an OIDC user — multi-user support requires
 * hash-lock to forward an X-Forwarded-User header (not currently the case),
 * at which point a `userId` field can be added to the record.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'TokenStore' });

/** Length of the random portion (in hex chars) of a generated token. */
const TOKEN_RANDOM_HEX_LEN = 32; // 16 bytes => 128 bits of entropy
/** Public prefix marker so support can grep logs for stray tokens. */
const TOKEN_PREFIX = 'mfwd_';
/** Number of hex chars (after the prefix) we surface in the dashboard list. */
const VISIBLE_PREFIX_LEN = 4;

export interface WebdavTokenRecord {
  id: string;
  label: string;
  hash: string;       // sha256(plaintext)
  prefix: string;     // first VISIBLE_PREFIX_LEN chars of the random portion
  createdAt: string;  // ISO 8601
}

/** Public view shown in the dashboard list — no plaintext, no hash. */
export interface WebdavTokenView {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
}

interface TokenFile {
  tokens: WebdavTokenRecord[];
}

export interface TokenStoreOptions {
  configDir: string;
}

export class TokenStore {
  private readonly file: string;
  private readonly configDir: string;

  constructor(opts: TokenStoreOptions) {
    this.configDir = opts.configDir;
    this.file = path.join(this.configDir, 'webdav-tokens.json');
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  private read(): TokenFile {
    if (!fs.existsSync(this.file)) return { tokens: [] };
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as TokenFile;
      if (!Array.isArray(parsed.tokens)) return { tokens: [] };
      return parsed;
    } catch (err) {
      logger.warn(`Token store ${this.file} unreadable, treating as empty:`, err);
      return { tokens: [] };
    }
  }

  /**
   * Atomic write — write to a sibling tmp file and rename. WsgiDAV's
   * controller reads this file on every auth request, so a partial write
   * would briefly fail authentication.
   */
  private write(file: TokenFile): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  /** Public list — no plaintext, no hash. */
  list(): WebdavTokenView[] {
    return this.read().tokens.map(({ id, label, prefix, createdAt }) => ({
      id, label, prefix, createdAt,
    }));
  }

  /**
   * Mint a new token. Returns the plaintext exactly once — the caller is
   * responsible for surfacing it to the user and forgetting it.
   */
  create(label: string): { plaintext: string; view: WebdavTokenView } {
    const random = crypto.randomBytes(TOKEN_RANDOM_HEX_LEN / 2).toString('hex');
    const plaintext = `${TOKEN_PREFIX}${random}`;
    const id = crypto.randomBytes(8).toString('hex');
    const record: WebdavTokenRecord = {
      id,
      label: label.trim() || 'Unnamed token',
      hash: crypto.createHash('sha256').update(plaintext).digest('hex'),
      prefix: random.slice(0, VISIBLE_PREFIX_LEN),
      createdAt: new Date().toISOString(),
    };

    const file = this.read();
    file.tokens.push(record);
    this.write(file);

    logger.info(`Minted WebDAV token id=${id} label=${JSON.stringify(record.label)}`);
    return {
      plaintext,
      view: { id, label: record.label, prefix: record.prefix, createdAt: record.createdAt },
    };
  }

  /** Delete by id. Returns true if a record was removed. */
  revoke(id: string): boolean {
    const file = this.read();
    const idx = file.tokens.findIndex(t => t.id === id);
    if (idx < 0) return false;
    file.tokens.splice(idx, 1);
    this.write(file);
    logger.info(`Revoked WebDAV token id=${id}`);
    return true;
  }
}
