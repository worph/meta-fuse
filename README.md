# Meta-Fuse

Standalone virtual filesystem service that exposes metadata-organized content via FUSE and WebDAV without duplicating files.

## Overview

Meta-Fuse is a read-only process in the MetaMesh ecosystem that:

1. **Connects to shared KV storage** - Reads metadata from Redis/compatible KV database managed by meta-sort
2. **Mounts virtual filesystem** - Rust-based FUSE driver creates an organized view of media files
3. **Serves WebDAV** - Network-accessible file sharing for Windows/Mac/Linux clients
4. **Zero file duplication** - All content points to original files via WebDAV or direct volume access
5. **Leader-aware KV access** - Discovers and connects to the active KV database via lock file
6. **WebDAV file access** - Can read files from meta-sort's WebDAV server (supports SMB/rclone mounts)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MetaMesh Ecosystem                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   DATA Volume (Shared)          KV Database (Leader Election)               │
│   ┌────────────────────┐        ┌────────────────────────────┐              │
│   │ /data/watch/       │        │  Redis/Compatible DB        │              │
│   │ /data/output/      │◄──────┐│  - metadata storage         │              │
│   │ /mnt/remote/       │       ││  - file paths & attributes  │              │
│   └────────────────────┘       │└────────────────────────────┘              │
│            ▲                   │             ▲                               │
│            │                   │             │ reads                         │
│            │                   │             │                               │
│   ┌────────┴───────────────────┴─────────────┴──────────────────┐           │
│   │                        META-FUSE                             │           │
│   │  ┌─────────────────────────────────────────────────────────┐│           │
│   │  │                    KV Client Wrapper                     ││           │
│   │  │  - Reads lock file for leader discovery                  ││           │
│   │  │  - Connects to active KV database                        ││           │
│   │  │  - Reconnect loop for failure handling                   ││           │
│   │  └─────────────────────────────────────────────────────────┘│           │
│   │                            │                                 │           │
│   │              ┌─────────────┴─────────────┐                  │           │
│   │              ▼                           ▼                  │           │
│   │  ┌───────────────────────┐   ┌─────────────────────────┐   │           │
│   │  │    FUSE API Server    │   │    WebDAV Server        │   │           │
│   │  │    (Node.js/Fastify)  │   │    (WsgiDAV)            │   │           │
│   │  │    Port 3000          │   │    Port 8080            │   │           │
│   │  └───────────┬───────────┘   └───────────┬─────────────┘   │           │
│   │              │                           │                  │           │
│   │              ▼                           │                  │           │
│   │  ┌───────────────────────┐               │                  │           │
│   │  │    FUSE Driver        │◄──────────────┘                  │           │
│   │  │    (Rust)             │                                  │           │
│   │  │    /mnt/virtual       │                                  │           │
│   │  └───────────────────────┘                                  │           │
│   └─────────────────────────────────────────────────────────────┘           │
│                            │                                                 │
│                            ▼                                                 │
│              ┌─────────────────────────┐                                    │
│              │    nginx Reverse Proxy  │                                    │
│              │    /           → UI     │                                    │
│              │    /webdav     → WebDAV │                                    │
│              │    /api/fuse   → API    │                                    │
│              └─────────────────────────┘                                    │
│                            │                                                 │
└────────────────────────────┼────────────────────────────────────────────────┘
                             ▼
                    External Clients
                    (Windows/Mac/Linux)
```

### Service Role in MetaMesh

```
┌────────────────────────────────────────────────────────────────────────────┐
│  SERVICE ROLES                                                              │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [1] meta-sort (PROCESS-WRITE)                                             │
│      └─► Writes metadata to KV, manages remote mounts                       │
│                                                                             │
│  [2] meta-fuse (PROCESS-READ) ◄── YOU ARE HERE                             │
│      └─► Reads metadata from KV, exposes virtual filesystem                 │
│                                                                             │
│  [3] meta-stremio (PROCESS-READ)                                           │
│      └─► Reads metadata from KV, streams media content                      │
│                                                                             │
│  [4] meta-orbit (SHARING-READ-WRITE)                                       │
│      └─► P2P metadata sync across network                                   │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### KV Leader Election

All services in MetaMesh use a shared KV wrapper with leader election via flock(2):

```
/meta-core/locks/
└── kv-leader.lock      # flock-based leader election + endpoint info

Lock File Format (JSON):
{
  "host": "meta-sort-instance-1",
  "api": "redis://10.0.1.50:6379",
  "http": "http://10.0.1.50:3000",
  "timestamp": 1703808000000,
  "pid": 12345
}

Leader Election Flow:
1. meta-sort attempts exclusive flock on kv-leader.lock
2. Winner (leader) spawns Redis, writes endpoint to lock file
3. meta-fuse reads lock file to discover Redis endpoint
4. meta-fuse connects as read-only client
5. On leader failure, flock auto-releases, new leader elected
```

**Note**: meta-fuse never becomes leader - it only reads the lock file to discover the active Redis endpoint managed by meta-sort.

## Core Features

### Virtual Filesystem (FUSE)

- **Organized view**: Files appear in categorized folders (Movies, TV, Anime, etc.)
- **Path-to-inode mapping**: Translates filesystem paths to FUSE inode numbers
- **Attribute caching**: 1-second TTL for file attributes
- **Directory caching**: 30-second TTL for directory listings
- **Error resilience**: Virtual ERROR.txt shown when backend unavailable

### WebDAV Server

- **Network file sharing**: Mount as network drive on any OS
- **Read-only access**: Prevents accidental modifications
- **Basic authentication**: Username/password protection
- **Directory browsing**: Web-based file browser

### KV Client Wrapper

- **Leader discovery**: Reads lock file to find active database
- **Auto-reconnect**: Handles leader failover gracefully
- **Connection pooling**: Efficient database connections
- **Read-only operations**: No writes to KV database

## Package Structure

```
meta-fuse/
├── packages/
│   ├── meta-fuse-core/         # Core service (@meta-fuse/core)
│   │   ├── src/
│   │   │   ├── api/            # Fastify REST API (APIServer)
│   │   │   │   └── APIServer.ts
│   │   │   ├── kv/             # KV client wrapper (FOLLOWER mode only)
│   │   │   │   ├── IKVClient.ts        # Read-only interface
│   │   │   │   ├── KVManager.ts        # Leader discovery, connection management
│   │   │   │   ├── LeaderDiscovery.ts  # Lock file reading
│   │   │   │   └── RedisClient.ts      # Redis connection with pub/sub
│   │   │   ├── vfs/            # Virtual filesystem logic
│   │   │   │   ├── VirtualFileSystem.ts    # In-memory VFS representation
│   │   │   │   ├── MetaDataToFolderStruct.ts # Folder organization
│   │   │   │   └── RenamingRule.ts     # Virtual path rules
│   │   │   └── index.ts        # Entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── meta-fuse-driver/       # Rust FUSE driver
│   │   ├── src/
│   │   │   ├── main.rs         # Entry point
│   │   │   ├── api_client.rs   # HTTP client to API server
│   │   │   └── inode_mapper.rs # Path-to-inode mapping
│   │   └── Cargo.toml
│   │
│   └── meta-fuse-ui/           # Monitoring dashboard (optional)
│       ├── src/
│       └── package.json
│
├── docker/
│   ├── nginx.conf              # Reverse proxy config
│   ├── wsgidav.yaml            # WebDAV server config
│   ├── supervisord.conf        # Process management
│   └── entrypoint.sh           # Service orchestration
│
├── Dockerfile
├── docker-compose.yml
├── package.json                # Workspace root
├── pnpm-workspace.yaml
└── README.md
```

### Key Components (meta-fuse-core)

| Component | File | Purpose |
|-----------|------|---------|
| Entry Point | `src/index.ts` | Initializes KV manager, VFS, API server, pub/sub listener |
| API Server | `src/api/APIServer.ts` | Fastify REST API for FUSE operations (readdir, getattr, read) |
| KV Manager | `src/kv/KVManager.ts` | **FOLLOWER-only**: leader discovery, Redis connection, reconnection loop |
| Leader Discovery | `src/kv/LeaderDiscovery.ts` | Reads `/meta-core/locks/kv-leader.lock` to find active Redis |
| Redis Client | `src/kv/RedisClient.ts` | Wrapper around ioredis with pub/sub support |
| KV Interface | `src/kv/IKVClient.ts` | Read-only interface (get, scan, subscribe) |
| Virtual FS | `src/vfs/VirtualFileSystem.ts` | In-memory VFS representation with caching |
| Folder Organizer | `src/vfs/MetaDataToFolderStruct.ts` | Converts flat metadata to organized folder structure |
| Renaming Rules | `src/vfs/RenamingRule.ts` | Rules for virtual path organization |

**Note**: Unlike meta-sort, meta-fuse's KVManager is simplified:
- **Never spawns Redis** (always FOLLOWER)
- **Only reads metadata** (read-only interface)
- **Discovers leader** via lock file at `/meta-core/locks/kv-leader.lock`
- **No service discovery registration** (minimal footprint)

## Configuration

### Environment Variables

```bash
# Volume Paths
META_CORE_PATH=/meta-core                           # Infrastructure volume (locks, services)
FILES_VOLUME=/files                                 # Shared media volume

# KV Connection
REDIS_URL=                                          # Direct Redis URL (optional, skips discovery)
REDIS_PREFIX=meta-sort:                             # Key prefix in Redis

# API Server
API_PORT=3000                                       # API server port
API_HOST=0.0.0.0                                    # API bind address
VFS_REFRESH_INTERVAL=30000                          # VFS cache refresh interval (ms)

# FUSE Driver
FUSE_MOUNT_POINT=/mnt/virtual                       # Virtual filesystem mount
FUSE_API_URL=http://localhost:3000                  # API server URL
FUSE_FILE_MODE=644                                  # File permissions (octal)
FUSE_DIR_MODE=755                                   # Directory permissions (octal)
FUSE_ALLOW_OTHER=true                               # Allow other users

# User/Group
PUID=1000                                           # User ID for files
PGID=1000                                           # Group ID for files

# WebDAV (serving files to clients)
WEBDAV_PORT=8080                                    # WebDAV server port
WEBDAV_USERNAME=metamesh                            # WebDAV username
WEBDAV_PASSWORD=metamesh                            # WebDAV password
WEBDAV_READONLY=true                                # Read-only mode

# meta-sort WebDAV Access (reading files from meta-sort)
META_SORT_WEBDAV_URL=http://meta-sort-dev/webdav    # URL to access files via meta-sort's WebDAV
                                                    # Enables access to SMB/rclone mounts
```

### Docker Compose

```yaml
version: '3.8'

services:
  meta-fuse:
    build: .
    container_name: meta-fuse
    restart: unless-stopped
    privileged: true                    # Required for FUSE
    cap_add:
      - SYS_ADMIN
    devices:
      - /dev/fuse
    ports:
      - "80:80"                         # nginx (WebDAV, API)
    volumes:
      # Infrastructure volume (read-only for followers)
      - ${META_CORE_PATH:-./data/meta-core}:/meta-core:ro
      # Shared media volume (read-only)
      - ${FILES_PATH:-./data/files}:/files:ro
      # FUSE mount output (if exposing to host)
      - /mnt/metamesh:/mnt/virtual:rw,shared
    environment:
      - META_CORE_PATH=/meta-core
      - FILES_VOLUME=/files
      - FUSE_MOUNT_POINT=/mnt/virtual
      - REDIS_PREFIX=meta-sort:
      # Optional: Read files via meta-sort WebDAV (enables SMB/rclone mount access)
      - META_SORT_WEBDAV_URL=http://meta-sort/webdav
```

## API Endpoints

### FUSE API (Port 3000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/fuse/health` | Health check |
| GET | `/api/fuse/stats` | Filesystem statistics |
| POST | `/api/fuse/readdir` | List directory contents |
| POST | `/api/fuse/getattr` | Get file/directory attributes |
| POST | `/api/fuse/read` | Read file content |
| POST | `/api/fuse/exists` | Check path existence |

### Example Responses

**GET /api/fuse/stats**
```json
{
  "totalFiles": 1523,
  "totalDirectories": 48,
  "totalSize": 1847392847362,
  "categories": {
    "Movies": 523,
    "TV": 412,
    "Anime": 588
  },
  "kvConnection": "connected",
  "fuseMount": "mounted"
}
```

**POST /api/fuse/readdir**
```json
// Request
{ "path": "/Movies" }

// Response
{
  "entries": [
    "Action",
    "Comedy",
    "Drama",
    "Sci-Fi"
  ]
}
```

**POST /api/fuse/getattr**
```json
// Request
{ "path": "/Movies/Action/Movie.mkv" }

// Response
{
  "size": 4831838208,
  "mode": "file",
  "permissions": 644,
  "atime": "2024-01-15T10:30:00Z",
  "mtime": "2024-01-15T10:30:00Z",
  "ctime": "2024-01-15T10:30:00Z",
  "sourcePath": "/data/watch/downloads/Movie.2024.1080p.mkv"
}
```

## Usage

### Docker (Recommended)

```bash
# Start meta-fuse service
docker-compose up -d

# View logs
docker logs -f meta-fuse

# Check health
curl http://localhost/api/fuse/health
```

### Mount WebDAV (Windows)

```powershell
# Map network drive
net use Z: http://localhost/webdav /user:metamesh metamesh

# Access files
dir Z:\Movies
```

### Mount WebDAV (Linux)

```bash
# Install davfs2
sudo apt-get install davfs2

# Create mount point
mkdir -p ~/meta-fuse

# Mount
sudo mount -t davfs http://localhost/webdav ~/meta-fuse
# Enter credentials: metamesh / metamesh

# Access files
ls ~/meta-fuse/Movies
```

### Mount WebDAV (macOS)

```bash
# Using Finder: Go → Connect to Server
# Enter: http://localhost/webdav
# Credentials: metamesh / metamesh
```

## Development

### Prerequisites

- Node.js 21.6.2+
- pnpm 10.19.0+
- Rust 1.90+ (for FUSE driver)
- Docker & Docker Compose

### Local Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Start development mode
pnpm run dev

# Run tests
pnpm run test

# Lint
pnpm run lint
```

### Building FUSE Driver

```bash
cd packages/meta-fuse-driver
cargo build --release

# Run driver
./target/release/meta-fuse-driver \
  --mount-point /mnt/virtual \
  --api-url http://localhost:3000
```

### Project Scripts

| Command | Description |
|---------|-------------|
| `pnpm run build` | Build all packages |
| `pnpm run dev` | Development mode with hot reload |
| `pnpm run start:core` | Start core service |
| `pnpm run start:driver` | Start FUSE driver |
| `pnpm run test` | Run all tests |
| `pnpm run lint` | Lint all packages |

## How It Works

### Virtual Filesystem Flow

```
1. Client opens /mnt/virtual/Movies/Action/Movie.mkv
                    │
                    ▼
2. FUSE driver receives read request
   - Converts path to inode
   - Calls API: POST /api/fuse/getattr
                    │
                    ▼
3. API server queries KV database
   - Looks up metadata by virtual path
   - Returns sourcePath pointing to actual file
                    │
                    ▼
4. FUSE driver reads from sourcePath
   - /data/watch/downloads/Movie.2024.1080p.mkv
                    │
                    ▼
5. Content streamed to client
   - No file duplication
   - Direct read from original location
```

### KV Data Structure

meta-fuse reads metadata stored by meta-sort using the `meta-sort:` prefix:

```
# File metadata stored by meta-sort (hash-based keys)
meta-sort:file:{midhash256}:title         → "Inception"
meta-sort:file:{midhash256}:year          → "2010"
meta-sort:file:{midhash256}:filePath      → "media1/Movies/Inception (2010)/Inception.mkv"
meta-sort:file:{midhash256}:size          → 4831838208
meta-sort:file:{midhash256}:video/codec   → "h265"

# VFS paths are computed dynamically from metadata
# meta-fuse builds virtual paths like:
#   /Movies/Inception (2010)/Inception.mkv
#   → resolves to sourcePath: /files/media1/Movies/Inception (2010)/Inception.mkv
```

**Note**: File paths in Redis are **relative to FILES_VOLUME** (`/files`). meta-fuse prepends the FILES_VOLUME path when resolving actual file locations.

### Real-Time Updates via Pub/Sub

meta-fuse subscribes to Redis pub/sub channel `meta-sort:file:batch` for real-time metadata updates from meta-sort:

```typescript
interface BatchUpdateMessage {
    timestamp: number;
    changes: Array<{
        action: 'add' | 'update' | 'remove';
        hashId: string;
    }>;
}
```

When meta-sort adds/updates/removes files, it publishes batch updates. meta-fuse processes these to:
1. Invalidate affected caches
2. Rebuild virtual paths for modified files
3. Update directory listings without full refresh

This ensures the virtual filesystem stays synchronized with metadata changes in near real-time.

---

## Troubleshooting

### FUSE Mount Not Working

```bash
# Check if FUSE is available
ls -la /dev/fuse

# Verify mount
mount | grep virtual

# Check API health
curl http://localhost:3000/api/fuse/health

# View driver logs
journalctl -u meta-fuse-driver -f
```

### KV Connection Failed

```bash
# Check lock file exists
cat /data/apps/meta-core/db/redis.lock

# Verify redis is running (on leader)
redis-cli ping

# Check meta-fuse logs
docker logs meta-fuse | grep "KV"
```

### WebDAV Not Accessible

```bash
# Check WebDAV health
curl -u metamesh:metamesh http://localhost/webdav/

# Verify nginx is proxying
curl -I http://localhost/webdav

# Check WsgiDAV logs
docker logs meta-fuse | grep "wsgidav"
```

### Files Not Appearing

```bash
# Check KV has data
redis-cli keys "meta-fuse:vfs:*"

# Verify source files exist
ls -la /data/watch/

# Check API stats
curl http://localhost:3000/api/fuse/stats
```

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Core Service | Node.js + TypeScript | API server, VFS logic |
| HTTP Framework | Fastify 5.x | REST API |
| FUSE Driver | Rust + fuser | Filesystem interface |
| WebDAV | WsgiDAV (Python) | Network file sharing |
| KV Database | Redis (via ioredis) | Metadata storage |
| Reverse Proxy | nginx | Request routing |
| Containerization | Docker | Deployment |

## Integration with MetaMesh

Meta-Fuse is designed to work seamlessly with other MetaMesh services:

- **meta-sort**: Provides metadata in KV database
- **meta-stremio**: Can stream files exposed by meta-fuse
- **meta-orbit**: Syncs metadata across P2P network

### Connecting to meta-sort

Ensure meta-sort is running and has processed files:

```bash
# On meta-sort host
curl http://localhost:3000/api/processing/status

# Verify KV has metadata
redis-cli keys "meta-sort:file:*"
```

Meta-fuse will automatically discover the KV database through the shared lock file.

## License

MIT License - See [LICENSE](LICENSE) for details.
