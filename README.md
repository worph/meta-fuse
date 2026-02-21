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

All services in MetaMesh use leader discovery via meta-core's lock file and HTTP API:

```
/meta-core/locks/
├── kv-leader.lock      # flock-based leader election
└── kv-leader.info      # Leader API URL (plain text)

Lock Info File Format (plain text):
http://meta-core:9000

/urls API Response (JSON):
{
  "hostname": "meta-core-dev",
  "baseUrl": "http://localhost:8083",
  "apiUrl": "http://meta-core:9000",
  "redisUrl": "redis://meta-core:6379",
  "webdavUrl": "http://localhost:8083/webdav",
  "webdavUrlInternal": "http://meta-core:9000/webdav",
  "isLeader": true
}

Leader Discovery Flow:
1. meta-core acquires flock on kv-leader.lock
2. Winner (leader) spawns Redis, writes API URL to kv-leader.info
3. meta-fuse reads kv-leader.info to find API URL
4. meta-fuse calls /urls API to get Redis URL and other endpoints
5. meta-fuse connects to Redis as read-only client
6. On leader failure, flock auto-releases, new leader elected
```

**Note**: meta-fuse never becomes leader - it reads the lock file and calls the /urls API to discover the active Redis endpoint managed by meta-core.

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
│   │   │   ├── config/         # Configuration management
│   │   │   │   └── ConfigStorage.ts
│   │   │   ├── kv/             # KV client wrapper (FOLLOWER mode only)
│   │   │   │   ├── IKVClient.ts        # Read-only interface
│   │   │   │   ├── KVManager.ts        # Leader discovery, connection management
│   │   │   │   ├── LeaderClient.ts     # Lock file reading + /urls API
│   │   │   │   ├── RedisClient.ts      # Redis connection with Streams support
│   │   │   │   └── ServiceDiscovery.ts # Service discovery client
│   │   │   ├── vfs/            # Virtual filesystem logic
│   │   │   │   ├── VirtualFileSystem.ts       # In-memory VFS representation
│   │   │   │   ├── StreamingStateBuilder.ts   # Event-driven state management
│   │   │   │   ├── RulesPropertyExtractor.ts  # Property filtering from rules
│   │   │   │   ├── MetaDataToFolderStruct.ts  # Folder organization
│   │   │   │   ├── RenamingRule.ts            # Virtual path rules
│   │   │   │   ├── defaults/                  # Default renaming rules
│   │   │   │   ├── template/                  # Template engine components
│   │   │   │   │   ├── TemplateEngine.ts      # Variable interpolation
│   │   │   │   │   └── ConditionEvaluator.ts  # Rule condition evaluation
│   │   │   │   └── types/                     # TypeScript type definitions
│   │   │   │       └── RenamingRuleTypes.ts
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
├── docs/                       # Architecture documentation
│   ├── vfs-rebuild-architecture.md
│   ├── streaming-architecture.md
│   └── api-reference.md
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
| Entry Point | `src/index.ts` | Initializes KV manager, VFS, API server, stream consumer |
| API Server | `src/api/APIServer.ts` | Fastify REST API for FUSE operations and rules management |
| KV Manager | `src/kv/KVManager.ts` | **FOLLOWER-only**: leader discovery, Redis connection, reconnection loop |
| Leader Client | `src/kv/LeaderClient.ts` | Reads `/meta-core/locks/kv-leader.info`, calls `/urls` API |
| Redis Client | `src/kv/RedisClient.ts` | Wrapper around ioredis with Redis Streams support |
| Service Discovery | `src/kv/ServiceDiscovery.ts` | Discovers all MetaMesh services via service files |
| KV Interface | `src/kv/IKVClient.ts` | Read-only interface (get, scan, subscribe) |
| Virtual FS | `src/vfs/VirtualFileSystem.ts` | In-memory VFS representation with caching |
| Streaming State Builder | `src/vfs/StreamingStateBuilder.ts` | Processes `meta:events` stream, builds VFS state incrementally |
| Rules Property Extractor | `src/vfs/RulesPropertyExtractor.ts` | Extracts VFS-relevant properties from renaming rules |
| Folder Organizer | `src/vfs/MetaDataToFolderStruct.ts` | Converts flat metadata to organized folder structure |
| Renaming Rules | `src/vfs/RenamingRule.ts` | Rules for virtual path organization |
| Template Engine | `src/vfs/template/TemplateEngine.ts` | Variable interpolation for renaming templates |
| Condition Evaluator | `src/vfs/template/ConditionEvaluator.ts` | Evaluates rule conditions against file metadata |

**Note**: Unlike meta-sort, meta-fuse's KVManager is simplified:
- **Never spawns Redis** (always FOLLOWER)
- **Only reads metadata** (read-only interface)
- **Discovers leader** via lock file at `/meta-core/locks/kv-leader.info`
- **Calls `/urls` API** to get Redis URL, WebDAV URL, and other endpoints
- **Uses streaming mode** - processes `meta:events` stream for real-time updates

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

# meta-core WebDAV Access (reading files from meta-core)
META_CORE_WEBDAV_URL=http://meta-core/webdav        # URL to access files via meta-core's WebDAV
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
      # Optional: Read files via meta-core WebDAV (enables SMB/rclone mount access)
      - META_CORE_WEBDAV_URL=http://meta-core/webdav
```

## API Endpoints

### FUSE API (Port 3000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Health & Status** |
| GET | `/health` | Health check |
| GET | `/api/health` | Health check (alias) |
| GET | `/api/fuse/health` | Health check (alias) |
| GET | `/api/fuse/stats` | Filesystem statistics |
| **FUSE Operations** |
| POST | `/api/fuse/readdir` | List directory contents |
| POST | `/api/fuse/getattr` | Get file/directory attributes |
| POST | `/api/fuse/exists` | Check path existence |
| POST | `/api/fuse/read` | Read file content (returns source path or WebDAV URL) |
| POST | `/api/fuse/metadata` | Get full metadata for a path |
| GET | `/api/fuse/files` | List all virtual files |
| GET | `/api/fuse/directories` | List all virtual directories |
| POST | `/api/fuse/refresh` | Trigger VFS refresh |
| **Renaming Rules** |
| GET | `/api/fuse/rules` | Get current renaming rules configuration |
| PUT | `/api/fuse/rules` | Update renaming rules configuration |
| POST | `/api/fuse/rules/preview` | Preview how files would be renamed |
| POST | `/api/fuse/rules/validate` | Validate a single rule |
| GET | `/api/fuse/rules/variables` | Get list of available template variables |
| **Service Discovery** |
| GET | `/api/services` | List all discovered MetaMesh services |

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

meta-fuse reads metadata stored by meta-sort using flat Redis keys:

```
# File metadata stored by meta-sort (flat key format)
file:{hashId}/title          → "Inception"
file:{hashId}/year           → "2010"
file:{hashId}/filePath       → "media1/Movies/Inception (2010)/Inception.mkv"
file:{hashId}/size           → 4831838208
file:{hashId}/video/codec    → "h265"
file:{hashId}/titles/eng     → "Inception"

# File index for enumeration
file:__index__               → SET of all hashIds

# VFS paths are computed dynamically from metadata
# meta-fuse builds virtual paths like:
#   /Movies/Inception (2010)/Inception.mkv
#   → resolves to sourcePath: /files/media1/Movies/Inception (2010)/Inception.mkv
```

**Key Format**: `file:{hashId}/{property}` where:
- `hashId` is the midhash256 content identifier
- `property` can be flat (e.g., `title`) or nested (e.g., `titles/eng`)

**Note**: File paths in Redis are **relative to FILES_VOLUME** (`/files`). meta-fuse prepends the FILES_VOLUME path when resolving actual file locations.

### Real-Time Updates via Redis Streams

meta-fuse uses the `meta:events` Redis Stream for real-time metadata updates. The streaming architecture provides:
- **Reliable delivery** - Messages persist until consumed
- **Replay capability** - Can rebuild state from stream position 0
- **Memory efficiency** - Only VFS-relevant properties are fetched

```typescript
// Stream message format (meta:events)
interface StreamMessage {
    id: string;           // Stream entry ID (e.g., "1703808000000-0")
    type: 'set' | 'del';  // Operation type
    key: string;          // Redis key (e.g., "file:abc123/title")
    ts: string;           // Timestamp
}
```

**Startup Sequence**:
1. **Streaming Bootstrap**: Replay `meta:events` stream from position 0
2. **Build State**: Process each event, fetch only VFS-relevant properties
3. **Go Live**: Continue consuming new events from last processed position

**Event Processing Pipeline**:
1. Parse key to extract `hashId` and `property`
2. Check if property is VFS-relevant (based on renaming rules)
3. If relevant, fetch property value from Redis
4. Update internal state and notify VFS
5. When file has `filePath`, it appears in VFS

This streaming architecture enables:
- Sub-second startup (no HGETALL/SCAN)
- Memory-efficient state (~500 bytes/file)
- Real-time VFS updates as files are processed

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
cat /meta-core/locks/kv-leader.info

# Check /urls API
curl http://localhost:8083/api/urls

# Verify redis is running (on leader)
docker exec meta-core-dev redis-cli ping

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
# Check Redis has file data (flat key format)
docker exec meta-core-dev redis-cli keys "file:*" | head -20

# Check file index
docker exec meta-core-dev redis-cli scard "file:__index__"

# Verify source files exist
ls -la /files/watch/

# Check API stats
curl http://localhost:3000/api/fuse/stats

# Check streaming state builder stats
docker logs meta-fuse-dev | grep "State builder"
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
# Check meta-sort processing status
curl http://localhost:8180/api/processing/status

# Verify Redis has metadata (via meta-core)
docker exec meta-core-dev redis-cli scard "file:__index__"

# Check meta:events stream has events
docker exec meta-core-dev redis-cli xlen "meta:events"
```

Meta-fuse will automatically discover the KV database through the shared lock file at `/meta-core/locks/kv-leader.info`.

## Documentation

For detailed architecture documentation, see the `docs/` directory:

- [VFS Rebuild Architecture](docs/vfs-rebuild-architecture.md) - How VFS state is built from Redis Streams
- [Streaming Architecture](docs/streaming-architecture.md) - Event processing pipeline details
- [API Reference](docs/api-reference.md) - Complete REST API documentation

## License

MIT License - See [LICENSE](LICENSE) for details.
