# API Documentation - AI HVAC Agent

REST API documentation for the AI HVAC Agent chatbot platform.

## Base URL

```
Production: https://your-domain.com
Development: http://localhost:3000
```

## Authentication

### Public Endpoints
No authentication required.

### Admin Endpoints
Requires valid admin session cookie (set via Google OIDC login).

### Chat Widget
Requires valid organization API key via `?key=` parameter.

---

## Chat Endpoints

### POST /api/chat

Send a message to the AI agent.

**Request:**
```json
{
  "message": "My AC is not cooling",
  "sessionId": "optional-existing-session-id"
}
```

**Response:** `text/event-stream` (Server-Sent Events)

Streaming response with AI agent replies. Each event contains a chunk of the response text.

**Status Codes:**
- `200` - Success (streaming response)
- `400` - Invalid request
- `429` - Rate limit exceeded
- `500` - Internal server error

**Example:**
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, I need HVAC help"}'
```

### GET /api/chat/history

Get customer's past chat sessions.

**Query Parameters:**
- `limit` (optional) - Number of sessions to return (default: 20)

**Response:**
```json
{
  "sessions": [
    {
      "id": "session_123",
      "createdAt": "2025-06-11T10:00:00Z",
      "status": "active",
      "messageCount": 5,
      "preview": "My AC is not cooling"
    }
  ]
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized

### GET /api/session

Get or create a chat session.

**Response:**
```json
{
  "id": "session_123",
  "messages": [
    {
      "id": "msg_456",
      "role": "assistant",
      "content": "Hi there! How can I help you with your HVAC needs today?",
      "createdAt": "2025-06-11T10:00:00Z"
    }
  ]
}
```

**Status Codes:**
- `200` - Success (existing or new session)
- `400` - Invalid request

---

## File Upload Endpoints

### POST /api/upload

Upload a file attachment (image only).

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | Image file (max 5MB, JPEG/PNG) |

**Response:**
```json
{
  "success": true,
  "attachment": {
    "id": "att_789",
    "url": "https://r2-url.com/storage-key.jpg",
    "mimeType": "image/jpeg",
    "size": 1234567
  }
}
```

**Status Codes:**
- `200` - Upload successful
- `400` - Invalid file (size, type, or magic bytes)
- `413` - File too large
- `500` - Upload failed

**Example:**
```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@photo.jpg"
```

---

## Admin Endpoints

### GET /api/admin/sessions

List all customer chat sessions.

**Query Parameters:**
- `status` (optional) - Filter by status (`active`, `archived`)
- `limit` (optional) - Results per page (default: 50)
- `offset` (optional) - Pagination offset

**Response:**
```json
{
  "sessions": [
    {
      "id": "session_123",
      "customer": {
        "name": "John Doe",
        "phone": "+15551234567",
        "email": "john@example.com"
      },
      "status": "active",
      "createdAt": "2025-06-11T10:00:00Z",
      "messageCount": 8,
      "serviceRequest": {
        "category": "ac",
        "urgency": "high",
        "problem": "AC not cooling"
      }
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized (no admin session)
- `403` - Forbidden (insufficient permissions)

### GET /api/admin/sessions/[id]

Get details of a specific session.

**Response:**
```json
{
  "session": {
    "id": "session_123",
    "customer": {...},
    "messages": [...],
    "serviceRequest": {...},
    "extraction": {...}
  }
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Session not found

### PATCH /api/admin/sessions/[id]

Update session metadata.

**Request:**
```json
{
  "status": "archived",
  "notes": "Customer called to follow up"
}
```

**Response:**
```json
{
  "success": true,
  "session": {...}
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid request
- `401` - Unauthorized
- `404` - Session not found

### DELETE /api/admin/sessions/[id]

Delete a session (soft delete by default).

**Response:**
```json
{
  "success": true
}
```

**Status Codes:**
- `200` - Success
- `401` - Unauthorized
- `404` - Session not found

### POST /api/admin/assign

Assign a technician to a service request.

**Request:**
```json
{
  "sessionId": "session_123",
  "technicianId": "tech_456"
}
```

**Response:**
```json
{
  "success": true,
  "assignment": {
    "id": "assign_789",
    "technician": {...},
    "assignedAt": "2025-06-11T10:30:00Z"
  }
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid request
- `401` - Unauthorized
- `404` - Session or technician not found

---

## Team Management Endpoints

### POST /api/admin/invite

Create a team invite link.

**Request:**
```json
{
  "email": "technician@example.com",
  "role": "technician"
}
```

**Response:**
```json
{
  "success": true,
  "invite": {
    "token": "abc123...",
    "url": "https://your-domain.com/admin/invite/abc123",
    "expiresAt": "2025-06-14T10:00:00Z"
  }
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid email or role
- `401` - Unauthorized
- `409` - Email already invited

### POST /api/admin/invite/[token]/accept

Accept a team invite.

**Request:**
```json
{
  "name": "Jane Technician",
  "password": "secure-password"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "user_456",
    "email": "technician@example.com",
    "role": "technician"
  }
}
```

**Status Codes:**
- `200` - Success
- `400` - Invalid request or password
- `401` - Unauthorized
- `404` - Invite not found or expired

---

## Widget Endpoints

### GET /widget.js

Embeddable chat widget script.

**Query Parameters:**
- `key` (required) - Organization API key

**Response:** `text/javascript`

JavaScript widget that embeds the chat interface.

**Status Codes:**
- `200` - Success
- `400` - Missing API key
- `404` - Invalid API key

### GET /embed

Embedded chat iframe page.

**Query Parameters:**
- `key` (required) - Organization API key

**Response:** `text/html`

Chat interface for iframe embedding.

**Status Codes:**
- `200` - Success
- `400` - Missing API key
- `404` - Invalid API key

---

## Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| POST /api/chat | 20 | 1 minute |
| GET /api/session | 5 | 1 minute |
| POST /api/upload | 10 | 1 minute |
| Admin mutations | 30 | 1 minute |
| Admin reads | 60 | 1 minute |

**Rate Limit Response:**
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 30
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_REQUEST` | Malformed request body |
| `UNAUTHORIZED` | Missing or invalid authentication |
| `FORBIDDEN` | Insufficient permissions |
| `NOT_FOUND` | Resource not found |
| `RATE_LIMITED` | Too many requests |
| `INVALID_FILE` | File upload validation failed |
| `FILE_TOO_LARGE` | File exceeds size limit |
| `INTERNAL_ERROR` | Server error |

---

## Webhooks (Future)

Not yet implemented, planned for:
- Technician assignment notifications
- Service request status updates
- Session completion events

---

## SDK Examples

### JavaScript/TypeScript

```typescript
// Send a message
const response = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'My AC is broken' })
});

// Stream response
const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(new TextDecoder().decode(value));
}
```

### Python

```python
import requests

# Send a message
response = requests.post(
    'http://localhost:3000/api/chat',
    json={'message': 'My AC is broken'},
    stream=True
)

# Read streaming response
for chunk in response.iter_content(chunk_size=None):
    if chunk:
        print(chunk.decode('utf-8'), end='')
```

### cURL

```bash
# Send a message
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "My AC is broken"}' \
  --no-buffer
```

---

## Changelog

### v0.2.0 (2025-06-11)
- Added history endpoint
- Added team invite endpoints
- Enhanced rate limiting with memory ceiling
- Added security headers

### v0.1.0 (2025-05-15)
- Initial release
- Chat endpoint with streaming
- File upload support
- Admin dashboard endpoints
