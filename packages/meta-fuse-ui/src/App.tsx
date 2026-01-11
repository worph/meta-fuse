import { useState, useEffect, useCallback } from 'react';
import { RulesEditor } from './components/RulesEditor';

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
    </div>
  );
}

export default App;
