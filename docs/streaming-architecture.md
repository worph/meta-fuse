# Streaming Architecture

## Overview

This document describes the streaming event processing system used by meta-fuse to maintain VFS state. The architecture uses Redis Streams for reliable, ordered event delivery with replay capability.

## Core Components

### StreamingStateBuilder

**File**: `src/vfs/StreamingStateBuilder.ts`

The StreamingStateBuilder is the central component for processing stream events and maintaining file metadata state.

```typescript
interface StreamingStateBuilderConfig {
    /** Redis client for fetching property values */
    redisClient: RedisClient;
    /** Renaming rules config for extracting VFS-relevant properties */
    rulesConfig: RenamingConfig;
    /** VFS update callback */
    vfsCallback?: VFSUpdateCallback;
    /** FILES_VOLUME path prefix */
    filesPath?: string;
}
```

**Responsibilities**:
- Process events from `meta:events` stream
- Filter events by VFS-relevant properties
- Fetch property values from Redis
- Maintain in-memory state of all files
- Notify VFS when files are complete or change

### RulesPropertyExtractor

**File**: `src/vfs/RulesPropertyExtractor.ts`

Analyzes renaming rules configuration to determine which metadata properties are needed for VFS path computation.

```typescript
class RulesPropertyExtractor {
    // Extract all VFS-relevant properties from rules config
    extractVfsProperties(config: RenamingConfig): Set<string>;

    // Get core properties that are always required
    getCoreProperties(): Set<string>;
}
```

**Core Properties** (always required):
- `filePath` - Source file location
- `size`, `fileSize` - File size
- `mtime`, `ctime` - Timestamps
- `fileName`, `extension` - Filename components

**Rule-Derived Properties** (extracted from templates and conditions):
- Template variables: `{title}`, `{season:pad2}`, `{episode:pad2}`
- Condition fields: `fileType`, `year`, `mediaType`

### VFSUpdateCallback

**File**: `src/vfs/StreamingStateBuilder.ts:32-37`

Interface for VFS to receive updates from StreamingStateBuilder:

```typescript
interface VFSUpdateCallback {
    // Called when a property value changes
    onPropertyChange(hashId: string, property: string, value: string): void;

    // Called when a property is deleted
    onPropertyDelete(hashId: string, property: string): void;

    // Called when a file is completely removed (filePath deleted)
    onFileDelete(hashId: string): void;

    // Called when a file becomes complete (has filePath) or updates
    onFileComplete(hashId: string, metadata: Record<string, string>): void;
}
```

---

## Event Processing Pipeline

### Stream Message Format

**File**: `src/kv/RedisClient.ts:30-43`

```typescript
interface StreamMessage {
    id: string;           // Stream entry ID (e.g., "1703808000000-0")
    type: 'set' | 'del';  // Operation type
    key?: string;         // Redis key (e.g., "file:abc123/title")
    ts?: string;          // Timestamp
    timestamp: string;    // Fallback timestamp
}
```

### 5-Step Event Processing

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Receive Stream Message                                 │
│  ────────────────────────────────────────────────────────────── │
│  {id: "1703808000-0", type: "set", key: "file:abc123/title"}   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: Parse Key                                              │
│  ────────────────────────────────────────────────────────────── │
│  parseMetaEventKey("file:abc123/title")                        │
│  → { hashId: "abc123", property: "title" }                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: Check VFS Relevance                                    │
│  ────────────────────────────────────────────────────────────── │
│  isVfsRelevantProperty("title", vfsRelevantProps)              │
│  → true (if "title" is in renaming rules)                      │
│  → false → skip, increment propertiesSkipped                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: Fetch Property Value                                   │
│  ────────────────────────────────────────────────────────────── │
│  await redisClient.getProperty("abc123", "title")              │
│  → "Inception"                                                  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: Update State & Notify VFS                              │
│  ────────────────────────────────────────────────────────────── │
│  updateProperty("abc123", "title", "Inception")                │
│  vfsCallback.onPropertyChange("abc123", "title", "Inception")  │
│                                                                 │
│  If file just became complete (now has filePath):              │
│    vfsCallback.onFileComplete("abc123", metadata)              │
└─────────────────────────────────────────────────────────────────┘
```

### Code Implementation

```typescript
// StreamingStateBuilder.ts:163-206
private async handlePropertySet(hashId: string, property: string): Promise<void> {
    // Step 3: Check if this property is VFS-relevant
    if (!isVfsRelevantProperty(property, this.vfsRelevantProps)) {
        this.stats.propertiesSkipped++;
        return;
    }

    // Step 4: Fetch the property value from Redis
    const value = await this.redisClient.getProperty(hashId, property);
    if (value === null) {
        return; // Property was set then deleted before we could fetch
    }

    this.stats.propertiesFetched++;

    // Check if file was complete BEFORE updating state
    const wasComplete = this.isFileComplete(hashId);

    // Step 5: Update internal state
    this.updateProperty(hashId, property, value);

    // Notify VFS of changes
    if (this.vfsCallback) {
        this.vfsCallback.onPropertyChange(hashId, property, value);

        // If file just became complete (has filePath now), notify VFS
        if (!wasComplete && this.isFileComplete(hashId)) {
            this.stats.filesComplete++;
            const metadata = this.getFileMetadata(hashId);
            if (metadata) {
                this.vfsCallback.onFileComplete(hashId, metadata);
            }
        }
    }
}
```

---

## Bootstrap vs Live Phases

### Bootstrap Phase

**When**: Application startup

**Goal**: Rebuild complete VFS state from event history

```typescript
// index.ts:158-174
// Bootstrap: Replay meta:events stream from position 0
const lastId = await redisClient.replayStream(
    EVENTS_STREAM,
    '0',                    // Start from beginning
    async (message: StreamMessage) => {
        await stateBuilder.processEvent(message);
    },
    100                     // Batch size
);
```

**Characteristics**:
- Reads from stream position `0` (all history)
- Non-blocking batch reads (no XREADGROUP)
- Processes all events sequentially
- Returns last processed event ID

### Live Phase

**When**: After bootstrap completes

**Goal**: Process new events in real-time

```typescript
// index.ts:177-187
redisClient.startSimpleStreamConsumer(
    EVENTS_STREAM,
    lastId,                 // Resume from bootstrap position
    async (message: StreamMessage) => {
        await stateBuilder.processEvent(message);
    },
    5000                    // 5 second block timeout
);
```

**Characteristics**:
- Resumes from last bootstrap position
- Uses blocking reads (XREAD BLOCK)
- Processes events as they arrive
- Runs until shutdown

---

## Memory Efficiency

### State Structure

```typescript
type FileState = Map<string, string>;      // property → value
type FilesState = Map<string, FileState>;  // hashId → properties
```

### Memory Per File

| Component | Size |
|-----------|------|
| hashId (64 char) | ~128 bytes |
| Map overhead | ~56 bytes |
| 5-10 properties (avg) | ~200-400 bytes |
| **Total per file** | **~400-600 bytes** |

### Comparison with Full Load

| Approach | Memory per File | 10K Files |
|----------|-----------------|-----------|
| Full HGETALL (all props) | ~2-5 KB | 20-50 MB |
| Streaming (VFS props only) | ~500 bytes | 5 MB |
| **Savings** | **75-90%** | **15-45 MB** |

### Why It Works

1. **Property Filtering**: Only fetch properties used in renaming rules
2. **Lazy Loading**: Properties fetched on-demand from events
3. **No Duplication**: Values stored once in state map
4. **Garbage Collection**: File state removed when file deleted

---

## Property Filtering Details

### Extracting VFS-Relevant Properties

```typescript
// RulesPropertyExtractor.ts:132-155
extractVfsProperties(config: RenamingConfig): Set<string> {
    const properties = new Set<string>(CORE_PROPERTIES);

    // Extract from all enabled rules
    for (const rule of config.rules) {
        if (!rule.enabled) continue;

        // From template: {title|originalTitle}, {season:pad2}
        const templateVars = templateEngine.extractVariables(rule.template);
        properties.add(...templateVars);

        // From conditions: { field: 'fileType', value: 'video' }
        const conditionFields = extractConditionFields(rule.conditions);
        properties.add(...conditionFields);
    }

    return properties;
}
```

### Property Path Matching

Handles both exact and nested property matching:

```typescript
// RulesPropertyExtractor.ts:85-111
function isVfsRelevantProperty(property: string, vfsProperties: Set<string>): boolean {
    const normalized = normalizePropertyPath(property);

    // Direct match
    if (vfsProperties.has(normalized)) {
        return true;
    }

    // Nested property match
    // e.g., if we track 'titles', then 'titles/eng' matches
    for (const vfsProp of vfsProperties) {
        if (normalized.startsWith(vfsProp + '.')) {
            return true;
        }
        if (vfsProp.startsWith(normalized + '.')) {
            return true;
        }
    }

    return false;
}
```

---

## Statistics and Monitoring

### StreamingStateBuilder Stats

```typescript
// StreamingStateBuilder.ts:68-74
private stats = {
    eventsProcessed: 0,     // Total events received
    propertiesFetched: 0,   // Properties fetched from Redis
    propertiesSkipped: 0,   // Non-VFS-relevant properties skipped
    filesComplete: 0,       // Files that became complete
    lastEventId: '0',       // Last processed event ID
};
```

### Accessing Stats

```typescript
const stats = stateBuilder.getStats();
// Returns:
{
    eventsProcessed: 15234,
    propertiesFetched: 8934,
    propertiesSkipped: 6300,
    filesComplete: 5123,
    lastEventId: "1703808000000-0",
    fileCount: 5123,        // Complete files (have filePath)
    stateSize: 5234         // Total files in state
}
```

### Interpreting Stats

| Metric | Meaning |
|--------|---------|
| `eventsProcessed` | Total stream events consumed |
| `propertiesFetched` | VFS-relevant property GET calls |
| `propertiesSkipped` | Non-relevant events filtered |
| `filesComplete` | Files added to VFS |
| `fileCount` | Current files in VFS |
| Fetch ratio | `propertiesFetched / eventsProcessed` (lower is better) |

---

## Error Handling

### Event Processing Errors

```typescript
// StreamingStateBuilder.ts:123-136
async processEvent(message: StreamMessage): Promise<void> {
    this.stats.eventsProcessed++;
    this.stats.lastEventId = message.id;

    if ((message.type === 'set' || message.type === 'del') && message.key) {
        await this.processMetaEvent(message);
        return;
    }

    // Ignore legacy event types - not supported in flat key architecture
    logger.debug(`Ignoring legacy event type: ${message.type}`);
}
```

### Property Fetch Failures

```typescript
// StreamingStateBuilder.ts:171-177
const value = await this.redisClient.getProperty(hashId, property);
if (value === null) {
    // Property was set then deleted before we could fetch it
    // Or it's a different data type - skip silently
    return;
}
```

### Stream Consumer Recovery

```typescript
// index.ts:185-187
.catch(error => {
    logger.error('Stream consumer error:', error);
});
```

On error, the consumer loop continues retrying with brief pauses.

---

## Configuration

### StreamingStateBuilder Configuration

```typescript
const stateBuilder = new StreamingStateBuilder({
    redisClient,
    rulesConfig: vfs.getRulesConfig(),
    vfsCallback: vfs,
    filesPath: '/files',
});
```

### Dynamic Rules Update

When renaming rules change:

```typescript
// StreamingStateBuilder.ts:99-102
updateRulesConfig(rulesConfig: RenamingConfig): void {
    this.vfsRelevantProps = this.propertyExtractor.extractVfsProperties(rulesConfig);
    logger.info(`Updated VFS-relevant properties: ${this.vfsRelevantProps.size}`);
}
```

---

## Related Documentation

- [VFS Rebuild Architecture](vfs-rebuild-architecture.md) - High-level architecture overview
- [API Reference](api-reference.md) - REST API documentation
- [Redis Key Format](../../../meta-core/docs/redis-format.md) - Flat key storage format
