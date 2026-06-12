# HTTP API Reference

The Agent framework provides a REST API server via `agent serve`.

## Starting the Server

```bash
agent serve --port 3000 --provider anthropic --model claude-sonnet-4-20250514
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Server port |
| `--provider` | auto | Provider type (anthropic/openai/deepseek/local/...) |
| `--model` | auto | Model name |
| `--max-turns` | `40` | Max turns per chat request |
| `--max-context` | `200000` | Max context tokens |

All endpoints are prefixed with `/api`.

---

## Health Check

```
GET /api/health
```

**Response:**

```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

---

## Chat Completion

```
POST /api/chat
```

Execute a single prompt against the agent.

**Request Body:**

```json
{
  "message": "Refactor the database connection pool",
  "sessionId": "20260524-182358-c11f"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | The prompt to execute |
| `sessionId` | string | no | Resume existing session; omit to create new |

**Response:**

```json
{
  "sessionId": "20260524-192358-a1b2",
  "content": "Here's the refactored connection pool...",
  "turns": 3,
  "toolCalls": [
    { "name": "read", "input": "src/db/pool.ts" },
    { "name": "edit", "input": "src/db/pool.ts" }
  ]
}
```

---

## Sessions

### List Sessions

```
GET /api/sessions
```

Returns all sessions for the current project, sorted by creation time descending.

### Create Session

```
POST /api/sessions
```

Creates a new session and returns its ID.

### Get Session

```
GET /api/sessions/:id
```

Returns session metadata.

### Delete Session

```
DELETE /api/sessions/:id
```

Permanently deletes a session and all its data.

---

## Tools

```
GET /api/tools
```

List all registered tools (built-in + MCP + plugin).

**Response:**

```json
[
  { "name": "read", "description": "Read file contents..." },
  { "name": "bash", "description": "Execute shell commands..." },
  { "name": "mcp__my-server__search", "description": "[MCP:my-server] Search documentation" }
]
```

---

## Skills

```
GET /api/skills
```

List all registered skills.

**Response:**

```json
[
  {
    "name": "code-review",
    "description": "Review code for bugs, style issues, and best practices",
    "source": "builtin"
  },
  {
    "name": "my-custom-skill",
    "description": "A file-based skill",
    "source": "file"
  }
]
```

---

## Error Responses

All endpoints return standard HTTP status codes:

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request (e.g., missing `message` field) |
| 404 | Resource not found (e.g., invalid session ID) |
| 500 | Internal server error |

Error bodies:

```json
{
  "error": "message is required"
}
```