# Stage 1

## Core Actions
1. **Fetch Notifications**: Retrieve paginated list of a user's notifications.
2. **Fetch Unread Count**: Get the number of unread notifications for badge display.
3. **Mark as Read**: Mark a specific notification as read.
4. **Mark All as Read**: Mark all of a user's notifications as read.

## REST API Design

### 1. Fetch Notifications
**Endpoint:** `GET /api/v1/notifications`
**Headers:**
```json
{
  "Authorization": "Bearer <JWT_TOKEN>"
}
```
**Query Parameters:** 
- `page` (int, default: 1)
- `limit` (int, default: 20)
- `unreadOnly` (boolean, default: false)

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "isRead": false,
      "createdAt": "2026-06-22T17:51:38Z"
    }
  ],
  "meta": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 100
  }
}
```

### 2. Mark Notification as Read
**Endpoint:** `PATCH /api/v1/notifications/:id/read`
**Headers:** `Authorization: Bearer <JWT_TOKEN>`
**Request Body:** (Empty)
**Response:** `204 No Content`

### 3. Mark All as Read
**Endpoint:** `POST /api/v1/notifications/read-all`
**Headers:** `Authorization: Bearer <JWT_TOKEN>`
**Response:** `200 OK`
```json
{ "message": "All notifications marked as read." }
```

## Real-Time Notification Mechanism
To deliver real-time notifications to the frontend without constant polling, I recommend using **WebSockets**. When a user logs in, the frontend establishes a persistent WebSocket connection to the server. When a new event (e.g., Placement, Result) occurs, the backend publishes the notification payload to the user's active WebSocket channel. This provides instant delivery and allows bidirectional communication (e.g., the client can emit a `notification_read` event to update the DB).


# Stage 2

## Persistent Storage Choice
I suggest using **PostgreSQL** (Relational DB) to start, and potentially migrating to a NoSQL solution like **Cassandra** or **MongoDB** at extreme scale. PostgreSQL provides strong ACID guarantees, which ensures data consistency. With proper indexing, it handles reads very efficiently.

## Database Schema (PostgreSQL)
```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_notifications_student_is_read ON notifications(student_id, is_read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);
```

## Scaling Problems & Solutions
**Problem:** As data volume increases (millions of rows), queries for unread notifications will become slower due to large index sizes, and the table will suffer from bloat, impacting read/write throughput.
**Solution:**
1. **Table Partitioning:** Partition the `notifications` table by date (e.g., monthly partitions). Old notifications are rarely queried.
2. **Archiving:** Move notifications older than 3-6 months to a cheaper "cold storage" DB or Data Warehouse.
3. **Caching:** Use Redis to cache the top 20 recent notifications and the unread count for active users.


# Stage 3

## Query Analysis
The query `SELECT * FROM notifications WHERE studentId = 1042 AND isRead = false ORDER BY createdAt DESC;` is functionally accurate, but it is slow because the database likely has to perform a **Sequential Scan** (or full table scan) over 5,000,000 rows to find records matching `studentId` and `isRead`, and then sort them in memory.

## Indexing Advice
Adding indexes on *every* column is **terrible advice**. Every index requires additional disk space and adds computational overhead to every `INSERT`, `UPDATE`, and `DELETE` operation. Over-indexing slows down write performance significantly.

**Effective Change:**
Create a composite index to explicitly support this query:
```sql
CREATE INDEX idx_student_unread_recent ON notifications(studentId, isRead, createdAt DESC);
```
**Computation Cost:** With this B-Tree index, the cost drops from O(N) (scanning millions of rows) to O(log N) to find the start of the index, and O(K) to fetch the K matching rows. The sorting step is completely eliminated because the index stores the records pre-sorted by `createdAt DESC`.

## Placement Notifications in Last 7 Days Query
```sql
SELECT * FROM notifications 
WHERE notificationType = 'Placement' 
  AND createdAt >= NOW() - INTERVAL '7 days';
```


# Stage 4

## Solving DB Overwhelm on Page Load
Fetching notifications directly from the DB on every page load is inefficient. 

**Solution 1: Redis Caching (Read-Aside)**
Instead of querying the DB on every page load, store the user's top `N` recent notifications and their `unread_count` in a Redis cache.
- On page load, fetch from Redis.
- If a cache miss occurs, query the DB and populate the cache.
- When a new notification is generated, push it to the user's Redis list and increment the cached count.
*Tradeoff:* Requires managing cache invalidation and adds infrastructure complexity (Redis), but drastically reduces DB load and latency.

**Solution 2: Client-Side State & WebSockets**
Instead of fetching on every page navigation, fetch the notifications *once* upon the initial application load and store them in global state (e.g., Redux, Context API). Use the WebSocket established in Stage 1 to receive new notifications and append them to the local state.
*Tradeoff:* Reduces server requests completely during navigation, but if the user opens multiple tabs, state synchronization can be tricky.


# Stage 5

## Shortcomings of the Pseudocode
1. **Synchronous Blocking Loop:** Processing 50,000 items in a sequential loop blocks the main thread. It will take minutes/hours to complete, leading to HTTP timeouts.
2. **Synchronous External API Calls:** `send_email` waits for a 3rd-party network response. If the email provider throttles or takes 1 second per email, this takes 13 hours.
3. **No Fault Tolerance/Retries:** If the process crashes halfway (like the logs indicated for the 200 users), there is no way to resume. Half the users didn't get emails, and we don't know who.
4. **Coupling:** Saving to the DB and sending emails should NOT happen in the same synchronous transaction. If email fails, does the DB rollback? If DB succeeds but email fails, the user is unaware of the notification.

## Redesign: Asynchronous Message Queue
To make this reliable and fast, we should decouple the operations using an Event-Driven Architecture with a Message Broker (like RabbitMQ, Kafka, or AWS SQS / SNS).
1. We perform a **Bulk DB Insert** for all 50,000 notifications in one efficient query.
2. We publish a single `Placement_Broadcast` event, or push 50,000 `Send_Email` jobs to a Queue.
3. Background Worker services consume the Queue, call the Email API concurrently, and handle retries natively.

## Revised Pseudocode
```python
# API Endpoint Handler
function notify_all(student_ids: array, message: string):
  # 1. Fast, single network round-trip using Bulk Insert
  bulk_save_to_db(student_ids, message)
  
  # 2. Push tasks to a highly scalable Message Queue
  for batch in chunk(student_ids, 500):
      MessageQueue.publish("email_jobs_queue", { ids: batch, msg: message })
      MessageQueue.publish("push_jobs_queue", { ids: batch, msg: message })

  return "Notifications queued for processing"

# Separate Background Worker Process (can be scaled horizontally)
function consume_email_jobs(job):
  try:
    send_email_batch(job.ids, job.msg)
  except APIError:
    # Queue handles automatic retries with exponential backoff
    raise RetryJobError()
```


# Stage 6

## Priority Inbox Approach

To handle the "Priority Inbox" feature that sorts by a combination of Weight and Recency, I assigned numerical weights to the types:
- `Placement` = 3
- `Result` = 2
- `Event` = 1

When fetching notifications, the array is sorted primarily by this `Weight` in descending order. If two notifications share the exact same weight (e.g., two 'Placement' notifications), they are secondarily sorted by the `Timestamp` in descending order (most recent first). 

**Efficient Maintenance of Top 10 for Streaming Updates:**
Currently, the Express application handles an HTTP request, fetches the array, sorts it, and slices the top 10. This `O(N log N)` sort is fine for a single API response payload.
However, to maintain the top 10 efficiently as **new notifications continuously arrive** in a live system, we should use a **Min-Heap (Priority Queue)** data structure constrained to a size of 10.
- When a new notification arrives, we compare its priority (Weight, then Recency) against the root of the Min-Heap (which represents the 10th highest priority notification).
- If the new notification has a higher priority, we pop the root and insert the new notification. 
- This insertion operation takes `O(log K)` where `K=10`, effectively meaning updates happen in `O(1)` constant time. This prevents us from having to re-sort the entire database or dataset every time a single event occurs.
