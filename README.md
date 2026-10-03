# Meta-Fuse

Standalone virtual filesystem service that exposes metadata-organized content via FUSE and WebDAV without duplicating files.

## Overview

Meta-Fuse is a read-only process in the MetaMesh ecosystem that:

1. **Locates meta-core over UDP** - meta-discovery v1 multicast announce (`239.255.77.1:9399`); no shared volume, no `REDIS_URL`
2. **Reads metadata through meta-core's HTTP API** - `/meta/{hash}*` reads + SSE live updates on `/api/events/meta` (no direct Redis access)
3. **Mounts virtual filesystem** - Rust-based FUSE driver creates an organized view of media files
4. **Serves WebDAV** - Network-accessible, read-only file sharing for Windows/Mac/Linux clients, authenticated with per-device tokens
5. **Zero file duplication** - File bytes are read from meta-core's WebDAV (`http://<meta-core host>/webdav`), which also covers SMB/rclone mounts; no `/files` mount required
6. **Configurable renaming rules** - Virtual paths are computed from metadata by editable rules (dashboard rules editor)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MetaMesh Ecosystem                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   meta-core (owns Redis)                                                     │
│   ┌──────────────────────────────────────────────┐                          │
│   │  UDP announce (meta-discovery v1, /urls)     │                          │
│   │  HTTP API: /meta/{hash}*, /api/events/meta   │                          │
│   │  WebDAV: /webdav  (file bytes, /files/...)   │                          │
│   └──────────────────────────────────────────────┘                          │
│            ▲ metadata (HTTP + SSE)          ▲ file bytes (WebDAV Range)      │
│   ┌────────┴────────────────────────────────┴───────────────────┐           │
│   │                        META-FUSE                             │           │
│   │  ┌─────────────────────────────────────────────────────────┐│           │
│   │  │       Storage client (KVManager / LeaderClient)          ││           │
│   │  │  - Locates meta-core via UDP (or META_CORE_URL pin)      ││           │
│   │  │  - Reads metadata over HTTP, events over SSE             ││           │
│   │  │  - Reconnects when a different meta-core announces       ││           │
│   │  └─────────────────────────────────────────────────────────┘│           │
│   │                            │                                 │           │
│   │              ┌─────────────┴─────────────┐                  │           │
│   │              ▼                           ▼                  │           │
│   │  ┌───────────────────────┐   ┌─────────────────────────┐   │           │
│   │  │    FUSE API Server    │   │    WebDAV Server        │   │           │
│   │  │    (Node.js/Fastify)  │   │    (WsgiDAV, token auth)│   │           │
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
│              │    nginx (port 80)      │                                    │
│              │    /           → UI     │                                    │
│              │    /webdav     → WebDAV │                                    │
│              │    /api/       → API    │                                    │
│              │    /health     → API    │                                    │
│              └─────────────────────────┘                                    │
│                            │                                                 │
└────────────────────────────┼────────────────────────────────────────────────┘
                             ▼
                    External Clients
                    (Windows/Mac/Linux)
```

In the dev stack and the CasaOS store app (`packages/MetaAppStore`, app `MetaFuse`) the backend runs as `metafuse-app` behind an OIDC perimeter container `metafuse` (`nginx-hash-lock` in dev, `appshield` in the store app); in the store app Caddy routes `/health` and `/webdav*` straight to the backend, so WebDAV is authenticated by WebDAV tokens instead. See the meta-root [authentication architecture](../../docs/project-architecture/authentication.md).

### Service Role in MetaMesh

```
┌────────────────────────────────────────────────────────────────────────────┐
│  SERVICE ROLES                                                              │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [1] meta-core (STORE)                                                      │
│      └─► Owns Redis, metadata HTTP API, event streams, WebDAV over /files   │
│                                                                             │
│  [2] meta-sort (PROCESS-WRITE)                                              │
│      └─► Watches folders, writes metadata through meta-core                 │
│                                                                             │
│  [3] meta-fuse (PROCESS-READ) ◄── YOU ARE HERE                              │
│      └─► Reads metadata from meta-core, exposes virtual filesystem          │
│                                                                             │
│  [4] meta-stremio (PROCESS-READ)                                            │
│      └─► Reads metadata, streams media content                              │
│                                                                             │
└────────────────────────────────────────────────────────────────────────────┘
```

### Locating meta-core (meta-discovery v1)

meta-core announces itself on UDP multicast `239.255.77.1:9399`, carrying its `/urls` payload. meta-fuse listens (and announces itself on the same group, so it shows up in every neighbour's nav menu):

```
/urls payload (JSON):
{
  "hostname": "metacore-app",
  "baseUrl": "https://metacore-dev.localhost:8083",
  "apiUrl": "http://<meta-core ip>:9000",
  "redisUrl": "",                       # always empty since the api-mediated-access lockdown
  "webdavUrl": "https://metacore-dev.localhost:8083/webdav",
  "webdavUrlInternal": "http://<meta-core ip>:9000/webdav"
}

Discovery flow:
1. meta-core announces role=core with its /urls payload
2. meta-fuse picks it up (or uses META_CORE_URL and GET {url}/urls when pinned)
3. meta-fuse reads metadata from apiUrl (/meta/{hash}*) and streams apiUrl/api/events/meta
4. File bytes are fetched from http://<hostname>/webdav
5. An announce carrying a different apiUrl triggers a reconnect
```

**Note**: meta-fuse never owns storage. If meta-core still publishes a non-empty `redisUrl`, meta-fuse refuses to start (set `ALLOW_LEGACY_REDIS_URL=1` to downgrade that to a warning). Protocol spec: [service-discovery.md](../../docs/project-architecture/service-discovery.md).

## Core Features

### Virtual Filesystem (FUSE)

- **Organized view**: Files appear in categorized folders (Movies, TV, Anime, etc.)
- **Path-to-inode mapping**: Translates filesystem paths to FUSE inode numbers
- **Attribute caching**: 1-second TTL for file attributes
- **Directory caching**: 30-second TTL for directory listings
- **Error resilience**: Virtual `ERROR.txt` shown after 3 consecutive API failures
- **WebDAV reads**: The driver issues HTTP Range requests against the `webdavUrl` returned by `/api/fuse/read`

### WebDAV Server

- **Network file sharing**: Mount as network drive on any OS
- **Read-only access**: Prevents accidental modifications
- **Per-device tokens**: Minted/revoked from the dashboard (`/api/webdav-tokens`); the token (`mfwd_…`) is the basic-auth password, any non-empty username is accepted. Only sha256 hashes are stored (`$CONFIG_DIR/webdav-tokens.json`); revocation is immediate
- **Directory browsing**: Web-based file browser

### Renaming Rules

- Stored in `$CONFIG_DIR/renaming-rules.json` (timestamped backups on update)
- Template variables + conditions; preview and validate via the API before saving
- Only the metadata properties the rules reference are fetched (`RulesPropertyExtractor`)

## Package Structure

```
meta-fuse/
├── packages/
│   ├── meta-fuse-core/         # Core service (@meta-fuse/core)
│   │   ├── src/
│   │   │   ├── api/APIServer.ts        # Fastify REST API
│   │   │   ├── config/ConfigStorage.ts # Renaming-rules persistence
│   │   │   ├── discovery/meshdisco.ts  # meta-discovery v1 (mirrored, see scripts/check-mirrors.sh)
│   │   │   ├── kv/                     # Storage client (read-only)
│   │   │   │   ├── IKVClient.ts        # Read-only interface
│   │   │   │   ├── KVManager.ts        # meta-core location, connection management
│   │   │   │   ├── LeaderClient.ts     # Adapter over MetaCoreLocator (UDP / META_CORE_URL pin)
│   │   │   │   ├── MetaCoreApiClient.ts # HTTP reads: /meta, /meta/{hash}, /meta/{hash}/{prop}
│   │   │   │   ├── SSEEventClient.ts   # SSE consumer for /api/events/meta
│   │   │   │   └── RedisClient.ts      # Storage facade (HTTP-only mode when redisUrl is empty)
│   │   │   ├── vfs/            # Virtual filesystem logic
│   │   │   │   ├── VirtualFileSystem.ts       # In-memory VFS representation
│   │   │   │   ├── StreamingStateBuilder.ts   # Event-driven state management
│   │   │   │   ├── RulesPropertyExtractor.ts  # Property filtering from rules
│   │   │   │   ├── MetaDataToFolderStruct.ts  # Folder organization
│   │   │   │   ├── RenamingRule.ts            # Virtual path rules
│   │   │   │   ├── defaults/                  # Default renaming rules
│   │   │   │   ├── template/                  # TemplateEngine, ConditionEvaluator
│   │   │   │   └── types/                     # RenamingRuleTypes.ts
│   │   │   ├── webdav/TokenStore.ts    # Per-device WebDAV tokens
│   │   │   └── index.ts        # Entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── meta-fuse-driver/       # Rust FUSE driver (fuser)
│   │   ├── src/
│   │   │   ├── main.rs         # Entry point, FUSE ops, inode mapping
│   │   │   └── api_client.rs   # HTTP client to API server
│   │   ├── Cargo.toml
│   │   └── Cargo.lock
│   │
│   └── meta-fuse-ui/           # Dashboard (Vite + React): stats, rules editor, WebDAV tokens
│
├── docs/                       # Architecture documentation
├── docker/
│   ├── nginx.conf                   # Reverse proxy config
│   ├── wsgidav.yaml                 # WebDAV server config
│   ├── webdav_token_controller.py   # WsgiDAV DomainController (token auth)
│   ├── supervisord.conf             # Process management
│   ├── start-fuse-driver.sh         # Waits for the API, then mounts
│   └── welcome.html
│
├── Dockerfile
├── docker-compose.yml          # Legacy standalone example (see note below)
├── package.json                # Workspace root
└── pnpm-workspace.yaml
```

### Key Components (meta-fuse-core)

| Component | File | Purpose |
|-----------|------|---------|
| Entry Point | `src/index.ts` | Initializes KV manager, VFS, SSE consumer, API server |
| API Server | `src/api/APIServer.ts` | Fastify REST API for FUSE operations, rules, tokens, neighbours |
| KV Manager | `src/kv/KVManager.ts` | Never owns storage: locates meta-core, builds the client, reconnects |
| Leader Client | `src/kv/LeaderClient.ts` | Locates meta-core over UDP (name is legacy: no election involved) |
| meta-core API Client | `src/kv/MetaCoreApiClient.ts` | `/meta/{hash}/{prop}`, `/meta/{hash}`, `/meta` reads |
| SSE Event Client | `src/kv/SSEEventClient.ts` | Consumes `/api/events/meta` (replays from `0-0` every start) |
| Virtual FS | `src/vfs/VirtualFileSystem.ts` | In-memory VFS representation with caching |
| Streaming State Builder | `src/vfs/StreamingStateBuilder.ts` | Turns `meta:events` into VFS state incrementally |
| Rules Property Extractor | `src/vfs/RulesPropertyExtractor.ts` | Extracts VFS-relevant properties from renaming rules |
| Folder Organizer | `src/vfs/MetaDataToFolderStruct.ts` | Converts flat metadata to organized folder structure |
| Template Engine | `src/vfs/template/TemplateEngine.ts` | Variable interpolation for renaming templates |
| Condition Evaluator | `src/vfs/template/ConditionEvaluator.ts` | Evaluates rule conditions against file metadata |
| Token Store | `src/webdav/TokenStore.ts` | Mints/lists/revokes WebDAV tokens |

## Configuration

### Environment Variables

```bash
# meta-core location
META_CORE_URL=                                      # Pin meta-core's API URL; UDP discovery never overrides it
ENABLE_UDP_DISCOVERY=true                           # false/0 disables meta-discovery
ALLOW_LEGACY_REDIS_URL=                             # 1 = warn instead of fail if meta-core publishes redisUrl

# Announce / nav menu
BASE_URL=                                           # External (Caddy) URL
PUBLIC_URL=                                         # Wins over BASE_URL (debug-direct port, no Caddy)

# Paths
FILES_VOLUME=/files                                 # Prefix for the relative filePath of each record
CONFIG_DIR=/meta-fuse/config                        # renaming-rules.json, webdav-tokens.json

# API Server
API_PORT=3000                                       # API server port
API_HOST=0.0.0.0                                    # API bind address

# VFS attributes (core)
FUSE_FILE_MODE=644                                  # File permissions (octal)
FUSE_DIR_MODE=755                                   # Directory permissions (octal)
PUID=1000                                           # File owner uid (core + driver)
PGID=1000                                           # File owner gid (core + driver)

# FUSE driver (args: <mountpoint> [api-url] [uid] [gid])
FUSE_API_URL=http://localhost:3000                  # Used when api-url arg is omitted
FUSE_FILE_PERM / FUSE_DIR_PERM                      # Driver-side permission overrides
                                                    # Mount always uses allow_other (needs user_allow_other in /etc/fuse.conf)

# WsgiDAV
TOKEN_STORE_PATH=/meta-fuse/config/webdav-tokens.json
```

### Docker Compose

The CasaOS store app (`packages/MetaAppStore/Apps/MetaFuse/docker-compose.yml`) is the reference deployment. Trimmed:

```yaml
services:
  metafuse-app:
    image: ghcr.io/worph/meta-fuse:<version>
    privileged: true                    # Required for FUSE
    cap_add: [SYS_ADMIN, DAC_READ_SEARCH, DAC_OVERRIDE]
    devices:
      - /dev/fuse:/dev/fuse
    security_opt:
      - apparmor:unconfined
    expose:
      - 80                              # nginx (UI, API, WebDAV)
    volumes:
      # No /meta-core mount (UDP discovery), no /files mount (WebDAV via meta-core)
      - ${DATA_ROOT:-/DATA}/MetaFuse/Library:/mnt/virtual:shared   # FUSE mount output
      - ${DATA_ROOT:-/DATA}/AppData/metafuse/config:/meta-fuse/config:rw
    environment:
      - CONFIG_DIR=/meta-fuse/config
      - BASE_URL=https://metafuse-$APP_DOMAIN
    networks: [pcs]                     # must share a multicast-capable network with meta-core
```

The repo-root `docker-compose.yml` predates meta-core (it sets `REDIS_URL` and mounts `/data`) and is not representative.

## API Endpoints

### FUSE API (Port 3000, proxied by nginx under `/api/` and `/health`)

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
| POST | `/api/fuse/read` | Resolve file content (source path / WebDAV URL) |
| POST | `/api/fuse/metadata` | Get full metadata for a path |
| GET | `/api/fuse/files` | List all virtual files |
| GET | `/api/fuse/directories` | List all virtual directories |
| POST | `/api/fuse/refresh` | Trigger VFS refresh (replays the event stream) |
| **Renaming Rules** |
| GET | `/api/fuse/rules` | Get current renaming rules configuration |
| PUT | `/api/fuse/rules` | Update renaming rules configuration |
| POST | `/api/fuse/rules/preview` | Preview how files would be renamed |
| POST | `/api/fuse/rules/validate` | Validate a single rule |
| GET | `/api/fuse/rules/variables` | Get list of available template variables |
| **WebDAV Tokens** |
| GET | `/api/webdav-tokens` | List tokens (hashes/prefixes only) |
| POST | `/api/webdav-tokens` | Create a token (`{ "label": "..." }`); plaintext returned once |
| DELETE | `/api/webdav-tokens/:id` | Revoke a token |
| **Service Discovery** |
| GET | `/api/neighbors` | Services heard over meta-discovery v1 (nav menu) |

### Example Responses

**GET /api/fuse/stats**
```json
{
  "fileCount": 1523,
  "directoryCount": 48,
  "totalSize": 1847392847362,
  "lastRefresh": "2026-01-15T10:30:00.000Z",
  "redisConnected": true
}
```

**POST /api/fuse/readdir**
```json
// Request
{ "path": "/Movies" }

// Response
{
  "entries": ["Action", "Comedy", "Drama", "Sci-Fi"]
}
```

**POST /api/fuse/getattr**
```json
// Request
{ "path": "/Movies/Action/Movie.mkv" }

// Response (mode includes the file-type bits; times are epoch seconds)
{
  "size": 4831838208,
  "mode": 33188,
  "mtime": 1705314600,
  "atime": 1705314600,
  "ctime": 1705314600,
  "nlink": 1,
  "uid": 1000,
  "gid": 1000
}
```

## Usage

### Docker

```bash
# Build the image (bundles UI, backend, FUSE driver, WsgiDAV, nginx)
docker build -t meta-fuse .

# Check health (through nginx on port 80)
curl http://localhost/health
```

Images are published to `ghcr.io/worph/meta-fuse` by `.github/workflows/docker-publish.yml`. In the meta-root dev stack the service is `metafuse-app` (`https://metafuse-dev.localhost:8181` via Caddy, debug-direct `http://localhost:18181`); rebuild it with `dev/scripts/reload-meta-fuse.sh`.

### Mount WebDAV

Create a token in the dashboard (WebDAV tokens panel) first; use it as the password. The username can be anything non-empty.

```powershell
# Windows
net use Z: https://<metafuse host>/webdav /user:me mfwd_xxxxxxxx
dir Z:\Movies
```

```bash
# Linux (davfs2)
sudo apt-get install davfs2
mkdir -p ~/meta-fuse
sudo mount -t davfs https://<metafuse host>/webdav ~/meta-fuse
# Credentials: any username / your mfwd_ token
ls ~/meta-fuse/Movies
```

```bash
# macOS: Finder → Go → Connect to Server → https://<metafuse host>/webdav
```

## Development

### Prerequisites

- Node.js 21.6.2+
- pnpm
- Rust 1.89+ (for FUSE driver; the Dockerfile builds with `rust:1.89-bookworm`)
- Docker & Docker Compose

### Local Development

```bash
pnpm install
pnpm run build     # all packages
pnpm run dev       # tsc --watch (core) + vite (ui), in parallel
pnpm run test      # @meta-fuse/core (mocha)
pnpm run lint
```

Inside the meta-root, prefer the dev stack's in-container build (`dev/scripts/reload-meta-fuse.sh`) — see the meta-root [CLAUDE.md](../../CLAUDE.md).

### Building FUSE Driver

```bash
cd packages/meta-fuse-driver
cargo build --release --locked

# Run driver: <mountpoint> [api-url] [uid] [gid]
./target/release/meta-fuse-driver /mnt/virtual http://localhost:3000
```

### Project Scripts

| Command | Description |
|---------|-------------|
| `pnpm run build` | Build all packages |
| `pnpm run dev` | Development mode with hot reload |
| `pnpm run start` / `start:core` | Start core service |
| `pnpm run start:ui` | Start UI dev server |
| `pnpm run test` | Run core tests |
| `pnpm run lint` | Lint all packages |

## How It Works

### Virtual Filesystem Flow

```
1. Client opens /mnt/virtual/Movies/Action/Movie.mkv
                    │
                    ▼
2. FUSE driver receives the request
   - Converts path to inode
   - Calls API: POST /api/fuse/getattr, then /api/fuse/read
                    │
                    ▼
3. API server resolves the path from its in-memory VFS
   - Returns a webdavUrl on meta-core's WebDAV for the source file
                    │
                    ▼
4. FUSE driver reads byte ranges from that URL (HTTP Range)
                    │
                    ▼
5. Content streamed to client
   - No file duplication
   - Bytes come from the original location via meta-core
```

### Metadata Access

meta-fuse never talks to Redis. It reads records through meta-core's HTTP API:

```
GET /meta                    → { hashIds: [...] }       enumerate records
GET /meta/{hash}             → { metadata: {...} }      full flat record
GET /meta/{hash}/{prop}      → text/plain value        one property (e.g. titles/eng)

# VFS paths are computed from metadata by the renaming rules, e.g.
#   /Movies/Inception (2010)/Inception.mkv
#   → filePath "media1/Movies/Inception (2010)/Inception.mkv" (relative to FILES_VOLUME)
```

Field names and value formats: meta-root [METADATA_KEYS.md](../../METADATA_KEYS.md). File paths are **relative to FILES_VOLUME** (`/files`).

### Real-Time Updates via SSE

meta-fuse consumes meta-core's `meta:events` stream through SSE at `GET {apiUrl}/api/events/meta`. Each event is a property change:

```typescript
// SSE event → StreamMessage
{
    id: string;           // Stream entry ID (e.g., "1703808000000-0")
    type: 'set' | 'del';  // SSE event name
    key: string;          // e.g. "file:abc123/title"
}
```

**Startup Sequence**:
1. **Bootstrap**: VFS state is held only in memory, so every start replays from cursor `0-0` (the cursor is deliberately not persisted; a `gap` event resumes from the oldest retained entry)
2. **Build State**: Parse `file:{hashId}/{property}`, skip properties the rules don't use, fetch the rest
3. **Go Live**: Keep consuming new events; a file appears in the VFS once it has a `filePath`

---

## Troubleshooting

### FUSE Mount Not Working

```bash
ls -la /dev/fuse                     # FUSE available?
mount | grep virtual                 # mounted?
curl http://localhost/api/fuse/health
# Driver logs (inside the container)
tail -f /var/log/supervisor/fuse-driver.log /var/log/supervisor/fuse-driver_error.log
```

### meta-core Not Found

```bash
# Who this service hears over UDP
curl http://localhost/api/neighbors

# meta-core's own view + URLs
curl -k https://metacore-dev.localhost:8083/api/neighbors
curl -k https://metacore-dev.localhost:8083/api/urls

# meta-fuse logs
docker logs metafuse-app | grep -E "LeaderClient|KVManager|SSE"
```

If multicast can't cross your network, pin it with `META_CORE_URL`.

### WebDAV Not Accessible

```bash
curl -u me:mfwd_xxxxxxxx http://localhost/webdav/   # 401 = bad/revoked token
docker exec metafuse-app tail /var/log/supervisor/wsgidav_error.log
```

### Files Not Appearing

```bash
curl http://localhost/api/fuse/stats
docker logs metafuse-app | grep "State builder"
curl -k https://metacore-dev.localhost:8083/api/stats   # does meta-core have records?
```

## Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Core Service | Node.js + TypeScript | API server, VFS logic |
| HTTP Framework | Fastify 5.x | REST API |
| FUSE Driver | Rust + fuser | Filesystem interface |
| WebDAV | WsgiDAV (Python) + token DomainController | Network file sharing |
| Metadata | meta-core HTTP API + SSE | Reads and live updates |
| Discovery | meta-discovery v1 (UDP multicast) | Locating meta-core and neighbours |
| Reverse Proxy | nginx | Request routing |
| Containerization | Docker + supervisord | Deployment |

## Integration with MetaMesh

- **meta-core**: Source of metadata (HTTP/SSE) and file bytes (WebDAV)
- **meta-sort**: Produces the metadata meta-fuse organizes
- **meta-stremio**: Reads the same metadata for streaming

```bash
# Is meta-sort producing records?
curl -k https://metasort-dev.localhost:8180/api/processing/status
curl -k https://metacore-dev.localhost:8083/api/stats
```

## Documentation

- [VFS Rebuild Architecture](docs/vfs-rebuild-architecture.md) - How VFS state is built from the event stream
- [Streaming Architecture](docs/streaming-architecture.md) - Event processing pipeline details
- [API Reference](docs/api-reference.md) - REST API documentation

(These predate the HTTP/SSE migration in places; the code is authoritative.)

## License

MIT (see `package.json`).
