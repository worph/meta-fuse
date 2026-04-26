import { useCallback, useEffect, useState } from 'react';

interface TokenView {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
}

interface CreatedToken extends TokenView {
  token: string; // plaintext, surfaced only once
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function WebdavTokens() {
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/webdav-tokens');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTokens(data.tokens ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await fetch('/api/webdav-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const created: CreatedToken = await res.json();
      setJustCreated(created);
      setNewLabel('');
      setCopied(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string, label: string) => {
    if (!confirm(`Revoke token "${label}"? Devices using it will lose WebDAV access immediately.`)) return;
    try {
      const res = await fetch(`/api/webdav-tokens/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyToken = async () => {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable on http; fall back silently.
    }
  };

  if (loading) return <div className="loading">Loading tokens…</div>;

  return (
    <div className="webdav-tokens">
      <p className="info-note">
        Generate one token per device and paste it as the basic-auth password
        when you add the WebDAV mount in Plex / Finder / Windows Explorer / etc.
        Any username works — the password is what authenticates. Revoke a
        token to cut off that single device without affecting the others.
      </p>

      {error && <div className="error">{error}</div>}

      {justCreated && (
        <div className="info-box" style={{ borderColor: '#10b981' }}>
          <h4>New token — copy it now</h4>
          <p className="info-note">
            This is the only time the full token will be shown. After you close
            this banner only the prefix will appear in the list.
          </p>
          <div className="command-box" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <code style={{ flex: 1, wordBreak: 'break-all' }}>{justCreated.token}</code>
            <button onClick={copyToken} className="refresh-btn">
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setJustCreated(null)}
            className="refresh-btn"
            style={{ marginTop: '0.5rem' }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="card-header">
          <span className="card-title">Generate token</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. 'Plex on living-room TV')"
            maxLength={200}
            style={{ flex: 1, padding: '0.5rem' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !creating) create(); }}
          />
          <button onClick={create} disabled={creating} className="refresh-btn">
            {creating ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      <div className="file-list" style={{ marginTop: '1rem' }}>
        {tokens.length === 0 ? (
          <div className="file-item">
            <span className="file-name" style={{ color: '#64748b' }}>
              No tokens yet — generate one to enable WebDAV access.
            </span>
          </div>
        ) : (
          tokens.map((t) => (
            <div key={t.id} className="file-item" style={{ justifyContent: 'space-between' }}>
              <div>
                <span className="file-name"><strong>{t.label}</strong></span>
                <div className="info-note">
                  <code>mfwd_{t.prefix}…</code> · created {formatDate(t.createdAt)}
                </div>
              </div>
              <button
                onClick={() => revoke(t.id, t.label)}
                className="refresh-btn"
                style={{ background: '#ef4444', color: 'white' }}
              >
                Revoke
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
