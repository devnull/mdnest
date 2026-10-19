package collab

import (
	"context"
	"log"
	"time"

	"nhooyr.io/websocket"
)

const (
	writeTimeout = 5 * time.Second
	pingInterval = 15 * time.Second
)

// Conn wraps a WebSocket connection with user identity.
type Conn struct {
	User UserInfo
	// ReadOnly marks a viewer without write access to the note: it receives
	// the room's events but its own cursor, selection and content messages
	// are dropped, so a reader can neither push text into a writer's editor
	// nor pose as an editor. Set before the read loop starts.
	ReadOnly bool
	ws       *websocket.Conn
	send     chan []byte
	// dropped is set when a reliable send could not be queued; the
	// connection is closed so the client reconnects and syncs again.
	dropped bool
}

// NewConn creates a new connection wrapper.
func NewConn(ws *websocket.Conn, userID int, username string) *Conn {
	return &Conn{
		User: UserInfo{
			ID:       userID,
			Username: username,
			Color:    colorForUser(userID),
		},
		ws:   ws,
		send: make(chan []byte, 256),
	}
}

// Close forcefully closes the WebSocket connection (normal closure).
func (c *Conn) Close() {
	c.ws.Close(websocket.StatusGoingAway, "replaced by new connection")
}

// Send queues a message to be sent. Non-blocking — drops if buffer full.
func (c *Conn) Send(data []byte) {
	select {
	case c.send <- data:
	default:
		// Buffer full — drop message to avoid blocking
	}
}

// SendReliable queues a message that must not be lost (a Yjs frame). If the
// buffer is full the connection is closed instead of dropping the message:
// a document missing one update stays wrong, while a reconnect fetches the
// whole room again.
func (c *Conn) SendReliable(data []byte) {
	select {
	case c.send <- data:
	default:
		if !c.dropped {
			c.dropped = true
			log.Printf("collab: send buffer full for %s; closing so it resyncs", c.User.Username)
			if c.ws != nil {
				go c.ws.Close(websocket.StatusTryAgainLater, "too slow, reconnect")
			}
		}
	}
}

// ReadLoop reads messages from the client and dispatches them.
// Blocks until the connection is closed.
func (c *Conn) ReadLoop(ctx context.Context, hub *Hub, ns, path string) {
	defer func() {
		hub.YjsLeave(ns, path, c)
		hub.Leave(ns, path, c)
		c.ws.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return // Connection closed
		}
		hub.HandleMessage(ns, path, c, typ == websocket.MessageBinary, data)
	}
}

// WriteLoop sends queued messages and pings. Blocks until done.
func (c *Conn) WriteLoop(ctx context.Context) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case data, ok := <-c.send:
			if !ok {
				return
			}
			writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(writeCtx, frameType(data), data)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pingCtx)
			cancel()
			if err != nil {
				log.Printf("collab: ping failed for %s: %v", c.User.Username, err)
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// frameType picks the websocket message type for a queued message. JSON
// starts with '{'; a shared editing frame starts with its tag byte (1 to 4),
// and must go out as binary: a browser fails the whole connection on a text
// frame that is not valid UTF-8.
func frameType(data []byte) websocket.MessageType {
	if len(data) > 0 && data[0] < 0x20 {
		return websocket.MessageBinary
	}
	return websocket.MessageText
}
