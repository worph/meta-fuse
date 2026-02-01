import { useState, useEffect, useCallback } from 'react';
import { RulesEditor } from './components/RulesEditor';
import ServiceNav from './components/ServiceNav';

interface Stats {
  fileCount: number;
  directoryCount: number;
  totalSize: number;
  lastRefresh: string | null;
  redisConnected: boolean;
}

interface HealthStatus {
  status: string;
  timestamp: string;
  service: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(isoString: string | null): string {
  if (!isoString) return 'Never';
  const date = new Date(isoString);
  return date.toLocaleTimeString();
}

function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, healthRes, dirsRes] = await Promise.all([
        fetch('/api/fuse/stats'),
        fetch('/api/fuse/health'),
        fetch('/api/fuse/directories'),
      ]);

      if (!statsRes.ok || !healthRes.ok) {
        throw new Error('Failed to fetch data');
      }

      const statsData = await statsRes.json();
      const healthData = await healthRes.json();
      const dirsData = await dirsRes.json();

      setStats(statsData);
      setHealth(healthData);
      setDirectories(dirsData.directories || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch('/api/fuse/refresh', { method: 'POST' });
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const dataInterval = setInterval(fetchData, 5000);
    return () => {
      clearInterval(dataInterval);
    };
  }, [fetchData]);

  if (loading) {
    return (
      <div className="container">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  const isConnected = health?.status === 'ok' && stats?.redisConnected;

  return (
    <div className="container">
      <ServiceNav />
      <header className="header">
        <div>
          <h1>meta-fuse</h1>
          <p className="header-subtitle">Virtual filesystem service</p>
        </div>
        <div className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <section className="description">
        <h2>What is meta-fuse?</h2>
        <p>
          <strong>meta-fuse</strong> is a virtual filesystem that presents your media files
          in an organized structure based on metadata. It reads file information from the
          KV leader (via Redis) and creates a virtual view of your library without duplicating any files.
        </p>
        <ul>
          <li>Access files organized by title, year, series, etc.</li>
          <li>Mount via FUSE (native) or WebDAV (network drive)</li>
          <li>No file duplication - virtual paths point to real files</li>
          <li>Automatically updates when new files are processed</li>
        </ul>
      </section>

      <section className="quick-links">
        <a href="/webdav" className="quick-link-card">
          <span className="quick-link-icon">📁</span>
          <div className="quick-link-content">
            <h3>WebDAV Files</h3>
            <p>Browse and access your organized media library. Mount as a network drive on any device.</p>
            <span className="quick-link-url">/webdav</span>
          </div>
        </a>
      </section>

      <div className="section">
        <h2 className="section-title">VFS Control</h2>

        <div className="grid">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Files</span>
            </div>
            <div className="card-value">{stats?.fileCount ?? 0}</div>
            <div className="card-subtitle">Total files in VFS</div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Directories</span>
            </div>
            <div className="card-value">{stats?.directoryCount ?? 0}</div>
            <div className="card-subtitle">Total directories</div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Total Size</span>
            </div>
            <div className="card-value">{formatBytes(stats?.totalSize ?? 0)}</div>
            <div className="card-subtitle">Combined file size</div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Last Refresh</span>
              <button
                className="refresh-btn"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            <div className="card-value" style={{ fontSize: '1.5rem' }}>
              {formatTime(stats?.lastRefresh ?? null)}
            </div>
            <div className="card-subtitle">From Redis metadata</div>
          </div>
        </div>

        <div className="card" style={{ marginTop: '1.5rem' }}>
          <div className="card-header">
            <span className="card-title">Connection Status</span>
          </div>
          <div className="info-grid">
            <div className="info-item">
              <div className="info-label">API Status</div>
              <div className="info-value">{health?.status ?? 'unknown'}</div>
            </div>
            <div className="info-item">
              <div className="info-label">Redis</div>
              <div className="info-value">
                {stats?.redisConnected ? 'Connected' : 'Disconnected'}
              </div>
            </div>
            <div className="info-item">
              <div className="info-label">Service</div>
              <div className="info-value">{health?.service ?? 'unknown'}</div>
            </div>
            <div className="info-item">
              <div className="info-label">Timestamp</div>
              <div className="info-value">{formatTime(health?.timestamp ?? null)}</div>
            </div>
          </div>
        </div>

        <div className="subsection">
          <div
            className="section-header-collapsible"
            onClick={() => setShowRules(!showRules)}
          >
            <h3 className="subsection-title">Renaming Rules</h3>
            <span className="collapse-icon">{showRules ? '-' : '+'}</span>
          </div>
          {showRules && (
            <RulesEditor onSave={fetchData} />
          )}
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">Virtual Directories</h2>
        <div className="file-list">
          {directories.length === 0 ? (
            <div className="file-item">
              <span className="file-name" style={{ color: '#64748b' }}>
                No directories found. Waiting for metadata from meta-sort...
              </span>
            </div>
          ) : (
            directories.slice(0, 20).map((dir) => (
              <div key={dir} className="file-item">
                <span className="file-icon">📁</span>
                <span className="file-name">{dir}</span>
              </div>
            ))
          )}
          {directories.length > 20 && (
            <div className="file-item">
              <span className="file-name" style={{ color: '#64748b' }}>
                ... and {directories.length - 20} more directories
              </span>
            </div>
          )}
        </div>
      </div>

      <section className="setup-section">
        <div
          className="setup-header"
          onClick={() => setShowSetup(!showSetup)}
        >
          <h3>Setup & Configuration</h3>
          <span className={`toggle-icon ${showSetup ? 'open' : ''}`}>▼</span>
        </div>
        {showSetup && (
          <div className="setup-content">
            <div className="info-box">
              <h4>FUSE Mount (Docker)</h4>
              <p>Mount the virtual filesystem directly from the container. Add this volume to your docker-compose.yml to access the organized files on your host:</p>
              <div className="command-box">
                <code>volumes:<br />&nbsp;&nbsp;- /path/on/host:/mnt/virtual:rw,shared</code>
              </div>
              <p className="info-note">The virtual filesystem is available inside the container at <code>/mnt/virtual</code></p>
            </div>

            <div className="info-box">
              <h4>WebDAV Network Drive</h4>
              <p>Mount the virtual filesystem as a network drive on any device:</p>
              <div className="command-box">
                <strong>Windows:</strong> <code>net use Z: http://&lt;host&gt;/webdav</code>
              </div>
              <div className="command-box">
                <strong>macOS:</strong> <code>Finder → Go → Connect to Server → http://&lt;host&gt;/webdav</code>
              </div>
              <div className="command-box">
                <strong>Linux:</strong> <code>sudo mount -t davfs http://&lt;host&gt;/webdav /mnt/vfs</code>
              </div>
            </div>
          </div>
        )}
      </section>

      <footer className="app-footer">
        <p>Part of the <strong>MetaMesh</strong> project</p>
        <p>Discovers KV leader via shared volume and connects to Redis automatically</p>
      </footer>
    </div>
  );
}

export default App;
