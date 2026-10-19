package collab

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"strings"
	"time"
)

// Shared editing rooms (Yjs).
//
// When shared editing is on, the browsers editing a markdown note keep one
// Yjs document between them. The server never parses Yjs: it relays opaque
// binary updates between the people in a note, and keeps the updates it has
// seen so someone who joins later gets the whole document. Files stay the
// source of truth: one browser per room (the "saver") writes the markdown
// through the ordinary PUT /api/note.
//
// Frames, client to server (binary websocket messages):
//
//	[1][update]                 a Yjs document update
//	[2][awareness]              a cursor/selection (awareness) update, relayed only
//	[3][ackSeq u64][snapshot]   the saver's compacted state, covering every
//	                            update up to ackSeq; replaces those log entries
//
// Frames, server to client:
//
//	[1][seq u64][update]        a relayed update and its position in the log
//	[2][awareness]              a relayed awareness update
//	[4][lastSeq u64]{[len u32][update]}*   the whole log, sent once on join
//
// Control messages are JSON text frames: yjs-hello, yjs-saved and yjs-leave
// from the client; yjs-seed, yjs-role, yjs-ready, yjs-compact, yjs-error and
// yjs-closed from the server.
//
// Single box only: rooms live in this process's memory. Several backend
// replicas would each keep their own room for the same note, so shared
// editing is switched off on MDNEST_ROLE=app and in a multi-replica Helm
// install (see docs/architecture.md).

const (
	yjsTagUpdate    byte = 1
	yjsTagAwareness byte = 2
	yjsTagSnapshot  byte = 3
	yjsTagState     byte = 4
)

// Room limits. Package variables so tests can shrink them.
var (
	// YjsMaxRoomConns caps how many connections can share one note.
	YjsMaxRoomConns = 32
	// YjsMaxLogBytes is the most update data one room keeps. An update that
	// would pass it is refused; the saver is asked to compact well before.
	YjsMaxLogBytes = 32 << 20
	// YjsMaxFrameBytes is the largest single frame accepted (a big paste or a
	// snapshot). The websocket read limit is set to this for every
	// connection when shared editing is on.
	YjsMaxFrameBytes int64 = 8 << 20
	// yjsCompactMin: below this the log is never compacted.
	yjsCompactMin = 1 << 20
	// yjsSaverIdle: the saver role moves to whoever is typing once the
	// current saver has not typed for this long. Two people typing at once
	// do not flip it on every keystroke.
	yjsSaverIdle = 5 * time.Second
	// yjsUnsavedGrace: how long an empty room with unsaved updates is kept,
	// so a reload or a quick return can still save them.
	yjsUnsavedGrace = 2 * time.Minute
)

type yjsEntry struct {
	seq  uint64
	data []byte
	from *Conn // nil for a snapshot
	own  int   // 1-based count of `from`'s own updates up to this one
	// saved: a yjs-saved has confirmed the file holds this update.
	saved bool
}

type yjsMember struct {
	joined     time.Time
	lastUpdate time.Time
	ownSent    int // updates this connection has sent
}

type yjsRoom struct {
	key       string
	members   map[*Conn]*yjsMember
	log       []yjsEntry
	bytes     int
	seq       uint64
	seeded    bool
	seeder    *Conn
	saver     *Conn
	compacted int // size of the last snapshot
	asked     bool
	freeTimer *time.Timer
}

type yjsControl struct {
	Type string `json:"type"`
	// Saver is always present on yjs-role, so false clearly means "you no
	// longer save". Seeding is its own message (yjs-seed).
	Saver  bool   `json:"saver"`
	Seeded bool   `json:"seeded,omitempty"`
	Error  string `json:"error,omitempty"`
	Reason string `json:"reason,omitempty"`
}

// EnableSharedEditing turns on the Yjs rooms. Off, every yjs message is
// ignored and clients keep the whole-file path.
func (h *Hub) EnableSharedEditing() { h.shared = true }

// SharedEditing reports whether Yjs rooms are on.
func (h *Hub) SharedEditing() bool { return h != nil && h.shared }

func sendControl(c *Conn, m yjsControl) {
	data, err := json.Marshal(m)
	if err == nil {
		c.SendReliable(data)
	}
}

// YjsHello adds conn to the note's room and sends it the room's state.
func (h *Hub) YjsHello(ns, path string, c *Conn) {
	if !h.shared {
		sendControl(c, yjsControl{Type: "yjs-error", Error: "off"})
		return
	}
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		r = &yjsRoom{key: key, members: make(map[*Conn]*yjsMember)}
		h.rooms[key] = r
	}
	if r.freeTimer != nil {
		r.freeTimer.Stop()
		r.freeTimer = nil
	}
	if _, ok := r.members[c]; ok {
		return
	}
	if len(r.members) >= YjsMaxRoomConns {
		sendControl(c, yjsControl{Type: "yjs-error", Error: "room-full"})
		if len(r.members) == 0 {
			delete(h.rooms, key)
		}
		return
	}
	r.members[c] = &yjsMember{joined: time.Now()}

	seed := false
	if !r.seeded && r.seeder == nil && !c.ReadOnly {
		r.seeder = c
		seed = true
	}
	becameSaver := false
	if r.saver == nil && !c.ReadOnly {
		r.saver = c
		becameSaver = true
	}
	c.SendReliable(r.stateFrame())
	if seed {
		sendControl(c, yjsControl{Type: "yjs-seed"})
	}
	sendControl(c, yjsControl{Type: "yjs-role", Saver: becameSaver})
	sendControl(c, yjsControl{Type: "yjs-ready", Seeded: r.seeded})
}

// stateFrame packs the whole log into one frame, so a long log cannot
// overflow the connection's send buffer one entry at a time.
func (r *yjsRoom) stateFrame() []byte {
	n := 9
	for _, e := range r.log {
		n += 4 + len(e.data)
	}
	buf := make([]byte, 9, n)
	buf[0] = yjsTagState
	binary.BigEndian.PutUint64(buf[1:9], r.seq)
	var l [4]byte
	for _, e := range r.log {
		binary.BigEndian.PutUint32(l[:], uint32(len(e.data)))
		buf = append(buf, l[:]...)
		buf = append(buf, e.data...)
	}
	return buf
}

// YjsFrame handles one binary frame from conn. Frames from a read-only
// connection, or from one that has not joined the room, are dropped: they are
// never relayed and never stored.
func (h *Hub) YjsFrame(ns, path string, c *Conn, data []byte) {
	if !h.shared || c.ReadOnly || len(data) < 1 {
		return
	}
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	m, ok := r.members[c]
	if !ok {
		return
	}
	switch data[0] {
	case yjsTagUpdate:
		upd := data[1:]
		if len(upd) == 0 {
			return
		}
		if r.bytes+len(upd) > YjsMaxLogBytes {
			log.Printf("collab: %s: room full (%d bytes), refusing an update from %s", key, r.bytes, c.User.Username)
			sendControl(c, yjsControl{Type: "yjs-error", Error: "room-too-big"})
			return
		}
		r.seq++
		m.ownSent++
		m.lastUpdate = time.Now()
		r.log = append(r.log, yjsEntry{seq: r.seq, data: upd, from: c, own: m.ownSent})
		r.bytes += len(upd)
		r.seeded = true
		r.seeder = nil

		frame := make([]byte, 9+len(upd))
		frame[0] = yjsTagUpdate
		binary.BigEndian.PutUint64(frame[1:9], r.seq)
		copy(frame[9:], upd)
		for o := range r.members {
			if o != c {
				o.SendReliable(frame)
			}
		}
		r.pickSaver(c)
		if !r.asked && r.saver != nil && r.bytes > yjsCompactMin && r.bytes > 4*r.compacted {
			r.asked = true
			sendControl(r.saver, yjsControl{Type: "yjs-compact"})
		}
	case yjsTagAwareness:
		for o := range r.members {
			if o != c {
				o.SendReliable(data)
			}
		}
	case yjsTagSnapshot:
		// Trusted from the saver only: the same trust as its PUT of the file.
		if c != r.saver || len(data) < 10 {
			return
		}
		ack := binary.BigEndian.Uint64(data[1:9])
		snap := append([]byte(nil), data[9:]...)
		if ack > r.seq {
			return
		}
		snapSaved := true
		for _, e := range r.log {
			if e.seq <= ack && !e.saved {
				snapSaved = false
			}
		}
		kept := []yjsEntry{{seq: ack, data: snap, saved: snapSaved}}
		size := len(snap)
		for _, e := range r.log {
			// Later entries stay. Some may already be in the snapshot;
			// applying a Yjs update twice changes nothing.
			if e.seq > ack {
				kept = append(kept, e)
				size += len(e.data)
			}
		}
		log.Printf("collab: %s: compacted %d entries / %d bytes into %d bytes (+%d later entries)",
			key, len(r.log), r.bytes, len(snap), len(kept)-1)
		r.log, r.bytes, r.compacted, r.asked = kept, size, len(snap), false
	}
}

// pickSaver gives the saver role to `typist` when there is no saver, or the
// current one has gone quiet. Caller holds ymu.
func (r *yjsRoom) pickSaver(typist *Conn) {
	if r.saver == typist {
		return
	}
	if r.saver != nil {
		if sm, ok := r.members[r.saver]; ok && time.Since(sm.lastUpdate) < yjsSaverIdle {
			return
		}
	}
	r.setSaver(typist)
}

func (r *yjsRoom) setSaver(c *Conn) {
	old := r.saver
	r.saver = c
	if old != nil && old != c {
		if _, still := r.members[old]; still {
			sendControl(old, yjsControl{Type: "yjs-role", Saver: false})
		}
	}
	if c != nil && c != old {
		sendControl(c, yjsControl{Type: "yjs-role", Saver: true})
	}
}

// YjsSaved records that the saver wrote the file. recv is the highest log seq
// the saver had applied when it took the text, own the number of its own
// updates it had sent by then.
func (h *Hub) YjsSaved(ns, path string, c *Conn, recv uint64, own int) {
	if !h.shared || c.ReadOnly {
		return
	}
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return
	}
	if _, ok := r.members[c]; !ok {
		return
	}
	for i := range r.log {
		e := &r.log[i]
		if e.seq <= recv || (e.from == c && e.own <= own) {
			e.saved = true
		}
	}
}

// hasUnsaved reports whether the log holds an update no save has covered.
// Conservative: anything not proven saved counts as unsaved.
func (r *yjsRoom) hasUnsaved() bool {
	for _, e := range r.log {
		if !e.saved {
			return true
		}
	}
	return false
}

// YjsLeave removes conn from the note's room (it also runs on disconnect).
func (h *Hub) YjsLeave(ns, path string, c *Conn) {
	key := noteKey(ns, path)
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	if _, ok := r.members[c]; !ok {
		return
	}
	delete(r.members, c)
	if r.seeder == c {
		r.seeder = nil
		if !r.seeded {
			if next := r.oldestWritable(); next != nil {
				r.seeder = next
				sendControl(next, yjsControl{Type: "yjs-seed"})
			}
		}
	}
	if r.saver == c {
		// The new saver saves whatever the old one had not: its document
		// holds every update, and it compares against the last saved text.
		r.saver = nil
		r.setSaver(r.latestWritable())
	}
	if len(r.members) > 0 {
		return
	}
	if !r.hasUnsaved() {
		delete(h.rooms, key)
		return
	}
	log.Printf("collab: WARNING %s: the last person left with unsaved updates (%d bytes); keeping the room %s for someone to save it",
		key, r.bytes, yjsUnsavedGrace)
	room := r
	r.freeTimer = time.AfterFunc(yjsUnsavedGrace, func() {
		h.ymu.Lock()
		defer h.ymu.Unlock()
		if h.rooms[key] == room && len(room.members) == 0 {
			delete(h.rooms, key)
			log.Printf("collab: WARNING %s: dropped a room with unsaved updates after %s; the file holds the last saved text", key, yjsUnsavedGrace)
		}
	})
}

func (r *yjsRoom) oldestWritable() *Conn {
	var best *Conn
	var at time.Time
	for c, m := range r.members {
		if c.ReadOnly {
			continue
		}
		if best == nil || m.joined.Before(at) {
			best, at = c, m.joined
		}
	}
	return best
}

func (r *yjsRoom) latestWritable() *Conn {
	var best *Conn
	var at time.Time
	for c, m := range r.members {
		if c.ReadOnly {
			continue
		}
		t := m.lastUpdate
		if t.IsZero() {
			t = m.joined
		}
		if best == nil || t.After(at) {
			best, at = c, t
		}
	}
	return best
}

// CloseMissingRooms closes the rooms in ns whose note no longer exists (moved,
// renamed or deleted). Its people get yjs-closed and fall back to the app's
// missing-note handling; nothing in a closed room is saved again.
func (h *Hub) CloseMissingRooms(ns string, exists func(path string) bool) {
	if !h.SharedEditing() {
		return
	}
	prefix := ns + ":"
	h.ymu.Lock()
	var check []string
	for key := range h.rooms {
		if len(key) > len(prefix) && key[:len(prefix)] == prefix {
			check = append(check, key)
		}
	}
	h.ymu.Unlock()
	for _, key := range check {
		if exists(key[len(prefix):]) {
			continue
		}
		h.closeRoom(key, "missing")
	}
}

func (h *Hub) closeRoom(key, reason string) {
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[key]
	if r == nil {
		return
	}
	if r.freeTimer != nil {
		r.freeTimer.Stop()
	}
	delete(h.rooms, key)
	for c := range r.members {
		sendControl(c, yjsControl{Type: "yjs-closed", Reason: reason})
	}
	log.Printf("collab: %s: room closed (%s)", key, reason)
}

// YjsMember reports whether conn has joined the note's room. Its old-style
// whole-document "content" messages are ignored then.
func (h *Hub) YjsMember(ns, path string, c *Conn) bool {
	if !h.shared {
		return false
	}
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return false
	}
	_, ok := r.members[c]
	return ok
}

// yjsRoomStats is for tests and logs.
type yjsRoomStats struct {
	Members, Entries, Bytes int
	Seeded                  bool
	Saver                   *Conn
}

func (h *Hub) roomStats(ns, path string) (yjsRoomStats, bool) {
	h.ymu.Lock()
	defer h.ymu.Unlock()
	r := h.rooms[noteKey(ns, path)]
	if r == nil {
		return yjsRoomStats{}, false
	}
	return yjsRoomStats{Members: len(r.members), Entries: len(r.log), Bytes: r.bytes, Seeded: r.seeded, Saver: r.saver}, true
}

// HandleMessage dispatches one websocket message from conn. Split out of the
// read loop so tests can drive it without a socket.
func (h *Hub) HandleMessage(ns, path string, c *Conn, binaryFrame bool, data []byte) {
	if binaryFrame {
		h.YjsFrame(ns, path, c, data) // drops read-only frames itself
		return
	}
	var msg IncomingMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	// A read-only viewer may join a room to receive it, and nothing else.
	switch msg.Type {
	case "yjs-hello":
		h.YjsHello(ns, path, c)
		return
	case "yjs-leave":
		h.YjsLeave(ns, path, c)
		return
	}
	if c.ReadOnly {
		return
	}
	switch msg.Type {
	case "yjs-saved":
		h.YjsSaved(ns, path, c, msg.Recv, msg.Own)
	case "cursor":
		h.BroadcastCursor(ns, path, c, msg)
	case "selection":
		h.BroadcastSelection(ns, path, c, msg)
	case "content":
		// The whole-document message belongs to the old path. In a shared
		// room it would push one person's copy over everyone's.
		if !h.YjsMember(ns, path, c) {
			h.BroadcastContent(ns, path, c, msg.Content)
		}
	}
}

// SharedEditingEnabled decides SHARED_EDITING (read only when live collab is
// on). On by default. Always off on MDNEST_ROLE=app: rooms live in one
// process's memory, so replicas would each hold a different room for the
// same note. A multi-replica Helm install sets SHARED_EDITING=false for the
// same reason.
func SharedEditingEnabled(setting, role string) bool {
	if role == "app" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(setting)) {
	case "false", "0", "no", "off":
		return false
	}
	return true
}
