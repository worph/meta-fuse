# VFS Rebuild Architecture

## Overview

This document describes the architecture and design philosophy for the Virtual Filesystem (VFS) rebuild process in MetaMesh. The system uses a **streaming-based strategy** with Redis Streams to provide fast startup times while maintaining data accuracy through event-driven updates.

## Design Philosophy

The VFS rebuild architecture is built on three core principles:

| Component | Role | Responsibility |
|-----------|------|----------------|
| **Redis** | Metadata Storage | Flat key storage of all file properties |
| **Redis Streams** | Event Log | Ordered record of all metadata changes (`meta:events`) |
| **StreamingStateBuilder** | State Manager | Processes events, maintains VFS-relevant state in memory |

### Key Insight

> **Redis stores the current truth** (what file properties exist)
> **Redis Streams store the change log** (what changed and when)
> **StreamingStateBuilder filters and projects** (extracts only VFS-relevant properties)

This separation enables:
- **Fast cold starts** (1-2 seconds for 10,000 files via stream replay)
- **Memory efficiency** (~500 bytes/file, only VFS-relevant properties)
- **Real-time updates** (live stream consumption after bootstrap)
- **Graceful handling of offline storage** (state rebuilds on reconnection)

---

## Streaming Architecture

### Phase 1: Streaming Bootstrap (Startup)

**Goal**: Rebuild VFS state as quickly as possible from event stream

**Implementation**: See `index.ts:158-174`

```typescript
// Bootstrap: Replay meta:events stream from position 0
const lastId = await redisClient.replayStream(
    EVENTS_STREAM,            // 'meta:events'
    '0',                      // Start from beginning
    async (message: StreamMessage) => {
        await stateBuilder.processEvent(message);
    },
    100                       // Batch size
);

const stats = vfs.getStats();
logger.info(`Streaming bootstrap complete: ${stats.fileCount} files`);
```

**How It Works**:
1. Read stream entries in batches using `XREAD`
2. For each `set` event, check if property is VFS-relevant
3. If relevant, fetch property value with `GET file:{hashId}/{property}`
4. Update in-memory state and notify VFS when file has `filePath`

**Performance**:
- 10,000 files: ~1-2 seconds
- Zero SCAN/HGETALL operations
- Only fetches properties needed for VFS path computation

**Characteristics**:
- Stream replay from position 0
- Incremental state building
- VFS populated as files become "complete" (have `filePath`)

---

### Phase 2: Live Stream Consumption

**Goal**: Keep VFS synchronized with metadata changes in real-time

**Implementation**: See `index.ts:177-187`

```typescript
// Start live stream consumer from where replay left off
redisClient.startSimpleStreamConsumer(
    EVENTS_STREAM,
    lastId,                   // Resume from bootstrap position
    async (message: StreamMessage) => {
        await stateBuilder.processEvent(message);
    },
    5000                      // 5 second block timeout
);
```

**Event Processing** (see `StreamingStateBuilder.ts:123-136`):

```typescript
async processEvent(message: StreamMessage): Promise<void> {
    // Handle new meta:events format (set/del with key field)
    if ((message.type === 'set' || message.type === 'del') && message.key) {
        await this.processMetaEvent(message);
        return;
    }
    // Legacy events ignored
}
```

**Property Filtering** (see `RulesPropertyExtractor.ts`):

```typescript
// Only fetch VFS-relevant properties
if (!isVfsRelevantProperty(property, this.vfsRelevantProps)) {
    this.stats.propertiesSkipped++;
    return;
}

// Fetch and update state
const value = await this.redisClient.getProperty(hashId, property);
this.updateProperty(hashId, property, value);
```

---

## Architecture Diagrams

### Startup Sequence

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Streaming Bootstrap                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Initialize KVManager (leader discovery)                             │
│     ├── Read /meta-core/locks/kv-leader.info                           │
│     ├── Call /urls API for Redis URL                                    │
│     └── Connect to Redis                                                 │
│                                                                          │
│  2. Create StreamingStateBuilder                                         │
│     ├── Extract VFS-relevant properties from rules                      │
│     └── Wire up VFS callback                                            │
│                                                                          │
│  3. Replay meta:events stream from position 0                           │
│     ┌────────────────────────────────────────────────────────────┐     │
│     │  For each event in stream:                                  │     │
│     │    ├── Parse key: file:{hashId}/{property}                 │     │
│     │    ├── Check if property is VFS-relevant                   │     │
│     │    ├── If yes: GET property value                          │     │
│     │    ├── Update in-memory state                              │     │
│     │    └── If file has filePath: notify VFS (file appears)    │     │
│     └────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  4. Start live consumer from last processed ID                          │
│     └── Continue processing new events in real-time                     │
│                                                                          │
│  5. Start API server                                                     │
│     └── VFS ready for FUSE/WebDAV operations                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Event Processing Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Event Processing Pipeline                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Redis Stream (meta:events)                                              │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │ {id: "1234-0", type: "set", key: "file:abc123/title"}        │       │
│  │ {id: "1234-1", type: "set", key: "file:abc123/filePath"}     │       │
│  │ {id: "1234-2", type: "del", key: "file:xyz789/filePath"}     │       │
│  └───────────────────────────────┬──────────────────────────────┘       │
│                                  │                                       │
│                                  ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │ StreamingStateBuilder.processEvent()                         │        │
│  │   1. Parse key → {hashId: "abc123", property: "title"}       │        │
│  │   2. Check VFS relevance (from RulesPropertyExtractor)       │        │
│  │   3. If relevant: GET file:abc123/title → "Inception"        │        │
│  │   4. Update state: state.get("abc123").set("title", ...)     │        │
│  └─────────────────────────────────────────────────────────────┘        │
│                                  │                                       │
│                                  ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │ VFSUpdateCallback                                            │        │
│  │   - onPropertyChange(hashId, property, value)                │        │
│  │   - onFileComplete(hashId, metadata) → file appears in VFS  │        │
│  │   - onFileDelete(hashId) → file removed from VFS            │        │
│  └─────────────────────────────────────────────────────────────┘        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## State Management

### StreamingStateBuilder State

```typescript
// FilesState: Map of hashId to property map
type FileState = Map<string, string>;      // property → value
type FilesState = Map<string, FileState>;  // hashId → properties

// Example state
{
    "abc123": {
        "filePath": "watch/Movies/Inception.mkv",
        "title": "Inception",
        "year": "2010",
        "size": "4831838208"
    },
    "xyz789": {
        "filePath": "watch/TV/Breaking Bad/S01E01.mkv",
        "title": "Breaking Bad",
        "season": "1",
        "episode": "1"
    }
}
```

### VFS-Relevant Properties

Properties are extracted from renaming rules (see `RulesPropertyExtractor.ts`):

**Core Properties** (always required):
- `filePath` - Source file location (required for file to appear)
- `size`, `fileSize` - File size
- `mtime`, `ctime` - Timestamps
- `fileName`, `extension` - Filename components

**Rule-Derived Properties**:
- From templates: `{title}`, `{season:pad2}`, `{episode:pad2}`
- From conditions: `{ field: 'fileType', value: 'video' }`

### Redis Data Structure

```
# Flat key format
file:{hashId}/{property}  →  value

# Examples
file:abc123/filePath      →  "watch/Movies/Inception.mkv"
file:abc123/title         →  "Inception"
file:abc123/titles/eng    →  "Inception"  (nested property)
file:abc123/year          →  "2010"

# Index
file:__index__            →  SET["abc123", "xyz789", ...]

# Event stream
meta:events               →  Stream of {type, key, ts} events
```

---

## Performance Characteristics

### Startup Performance

| Dataset Size | Streaming Bootstrap | Notes |
|--------------|---------------------|-------|
| 1,000 files | 0.5-1s | Stream replay + selective GET |
| 10,000 files | 1-2s | Batch processing (100 events) |
| 100,000 files | 10-15s | Memory-efficient incremental build |

### Memory Usage

- **Per-file overhead**: ~500 bytes (only VFS-relevant properties)
- **10,000 files**: ~5 MB
- **100,000 files**: ~50 MB
- **Comparison**: Previous HGETALL approach loaded all properties (~2-5KB/file)

### Why Streaming is Fast

| Old Approach | New Approach |
|--------------|--------------|
| `SCAN file:*` to find all keys | `XREAD meta:events` from position 0 |
| `HGETALL file:{id}` for each file | `GET file:{id}/{prop}` only for relevant props |
| All properties loaded | Only VFS-relevant properties |
| O(n × m) where m = all properties | O(n × k) where k = relevant properties |

---

## Handling Edge Cases

### New Files

1. meta-sort processes file, writes properties to Redis
2. meta-sort publishes `set` events to `meta:events` stream
3. meta-fuse consumes events, fetches relevant properties
4. When `filePath` is set, file appears in VFS

### Deleted Files

1. meta-sort publishes `del file:{hashId}/filePath` event
2. meta-fuse processes event, removes file from state
3. VFS updated, file disappears

### Redis Reconnection

1. Connection lost, stream consumer stops
2. KVManager detects disconnect, attempts reconnect
3. On reconnect, can replay stream from last position
4. State incrementally updated with missed events

### VFS Refresh

Triggered via `POST /api/fuse/refresh`:

```typescript
// Fallback for when stream is unavailable
async refresh(): Promise<void> {
    // Use flat key scanning fallback
    const files = await redisClient.scanFlatKeysForFiles(
        stateBuilder.getVfsRelevantProperties()
    );
    // Rebuild VFS from scanned data
}
```

---

## VFSUpdateCallback Interface

The VFS implements this callback interface to receive updates from StreamingStateBuilder:

```typescript
interface VFSUpdateCallback {
    // Property changed for a file
    onPropertyChange(hashId: string, property: string, value: string): void;

    // Property deleted from a file
    onPropertyDelete(hashId: string, property: string): void;

    // File completely removed (filePath deleted)
    onFileDelete(hashId: string): void;

    // File has all required properties, ready to appear in VFS
    onFileComplete(hashId: string, metadata: Record<string, string>): void;
}
```

The `onFileComplete` callback is called when:
1. A file first receives a `filePath` property
2. Subsequent property changes after file is already complete

---

## Monitoring and Debugging

### Startup Logs

```
[meta-fuse] Starting meta-fuse...
[KVManager] Waiting for leader...
[LeaderClient] Leader found: meta-core-dev at redis://meta-core:6379
[meta-fuse] KV Manager ready, initializing VFS with streaming bootstrap...
[StreamingStateBuilder] Initialized with 12 VFS-relevant properties
[meta-fuse] Replaying meta:events stream from position 0...
[RedisClient] Stream replay complete: 15234 entries in 1823ms
[meta-fuse] Streaming bootstrap complete: 5123 files in 1893ms
[meta-fuse] Starting live stream consumer from 1703808000000-0...
[meta-fuse] meta-fuse is ready!
[meta-fuse] VFS: 5123 files, 847 directories
[meta-fuse] State builder: 15234 events, 8934 properties fetched, 6300 skipped
```

### Stats API

```bash
curl http://localhost:3000/api/fuse/stats
```

```json
{
    "fileCount": 5123,
    "directoryCount": 847,
    "totalSize": 15847392847362,
    "lastRefresh": "2024-01-15T10:30:00Z",
    "stateBuilder": {
        "eventsProcessed": 15234,
        "propertiesFetched": 8934,
        "propertiesSkipped": 6300,
        "filesComplete": 5123,
        "lastEventId": "1703808000000-0"
    }
}
```

---

## Related Documentation

- [Streaming Architecture](streaming-architecture.md) - Detailed streaming event processing
- [API Reference](api-reference.md) - Complete API documentation
- [meta-core Architecture](../../../meta-core/docs/architecture.md) - Leader election and Redis management

---

## Summary

The VFS rebuild architecture achieves **fast startup and real-time updates** through:

- **Redis Streams** = Ordered event log with replay capability
- **StreamingStateBuilder** = Memory-efficient state projection
- **Property Filtering** = Only VFS-relevant properties fetched

This design enables:
- Sub-2-second cold starts (10k files)
- Real-time VFS updates via stream consumption
- Memory-efficient state (~500 bytes/file)
- Graceful reconnection and recovery

The key insight: **Stream replay + selective property fetching > Full scan + full data loading**
