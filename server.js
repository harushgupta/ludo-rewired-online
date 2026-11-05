'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const G = require('./game');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();
const clients = new Set();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return; }
  const files = { '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js' };
  const name = files[pathname];
  if (!name) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(PUBLIC, name), (err, data) => {
    if (err) { res.writeHead(500).end('Unable to load page'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(name)], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(data);
  });
});

// A small dependency-free WebSocket implementation for native browser clients.
// Handles RFC 6455 text frames (including fragmented frames), ping and close.
function sendFrame(socket, opcode, data) {
  if (socket.destroyed) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  let header;
  if (payload.length < 126) { header = Buffer.from([0x80 | opcode, payload.length]); }
  else if (payload.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  socket.write(Buffer.concat([header, payload]));
}
function json(client, obj) { sendFrame(client.socket, 1, JSON.stringify(obj)); }
function err(client, message) { json(client, { type: 'error', message: String(message).slice(0, 200) }); }
function freshCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function broadcast(room) {
  const now = Date.now();
  for (const client of clients) if (client.code === room.code && client.playerId) json(client, G.publicState(room, client.playerId, now));
}
function detach(client) {
  if (!client.code || !client.playerId) return;
  const room = rooms.get(client.code);
  if (room) {
    const p = room.players.find(p => p.id === client.playerId);
    if (p && ![...clients].some(c => c !== client && c.code === client.code && c.playerId === client.playerId)) {
      p.connected = false;
      G.record(room, `${p.name} disconnected. They can rejoin with the same browser.`, 'leave');
      if (room.phase === 'lobby' && p.id === room.hostId) room.hostId = room.players.find(x => x.connected)?.id || p.id;
      if (![...clients].some(c => c.code === room.code && c.playerId)) room.emptySince = Date.now();
      broadcast(room);
    }
  }
  client.code = null; client.playerId = null;
}
function associate(client, room, p) {
  // One active socket per player. Refresh/reconnect supersedes the old tab.
  for (const other of clients) if (other !== client && other.code === room.code && other.playerId === p.id) {
    other.code = null; other.playerId = null;
    err(other, 'Your session was opened in another tab.');
  }
  client.code = room.code; client.playerId = p.id;
  room.emptySince = null;
  p.connected = true;
  json(client, { type: 'identity', code: room.code, playerId: p.id, secret: p.secret });
  broadcast(room);
}
function action(client, m) {
  if (!m || typeof m !== 'object') throw new Error('Invalid request.');
  // Application heartbeat: verifies the connection and keeps active browser sockets healthy
  // behind hosting proxies without advancing game turns or changing room state.
  if (m.type === 'ping') { json(client, { type: 'pong', serverNow: Date.now() }); return; }
  if (m.type === 'create') {
    if (client.code) throw new Error('You are already in a room.');
    if (rooms.size >= 400) throw new Error('Too many active rooms. Please retry later.');
    const seconds = [60, 90, 120, 180].includes(m.interval) ? m.interval : 90;
    const room = G.newRoom(freshCode(), seconds);
    rooms.set(room.code, room);
    const p = G.addPlayer(room, m.name);
    associate(client, room, p);
    return;
  }
  if (m.type === 'join') {
    if (client.code) throw new Error('You are already in a room.');
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) throw new Error('Room not found. Double-check the 6-character code.');
    const p = G.addPlayer(room, m.name);
    associate(client, room, p);
    return;
  }
  if (m.type === 'resume') {
    if (client.code) throw new Error('Already connected.');
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room?.players.find(p => p.id === m.playerId && p.secret === m.secret);
    if (!room || !p) { json(client, { type: 'resumeFailed', message: 'This room has expired. Create a new room or join by code.' }); return; }
    G.record(room, `${p.name} reconnected.`, 'join');
    associate(client, room, p);
    return;
  }
  const room = rooms.get(client.code);
  if (!room || !client.playerId) throw new Error('Join a room first.');
  if (m.type === 'start') G.start(room, client.playerId);
  else if (m.type === 'roll') G.rolling(room, client.playerId);
  else if (m.type === 'power') G.choosePower(room, client.playerId, m.power, m.tokenIndex);
  else if (m.type === 'move') G.move(room, client.playerId, m.tokenIndex, m.mode);
  else if (m.type === 'pass') G.pass(room, client.playerId);
  else if (m.type === 'rematch') G.rematch(room, client.playerId);
  else if (m.type === 'leave') { detach(client); json(client, { type: 'left' }); return; }
  else if (m.type === 'settings') {
    if (room.phase !== 'lobby' || room.hostId !== client.playerId) throw new Error('Only the host can change pre-game settings.');
    if (![60, 90, 120, 180].includes(m.interval)) throw new Error('Choose 60, 90, 120 or 180 seconds.');
    room.resetIntervalMs = m.interval * 1000;
    G.record(room, `Chaos reset now happens every ${m.interval} seconds.`, 'info');
  } else throw new Error('Unknown action.');
  broadcast(room);
}

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/socket' || req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const client = { socket, code: null, playerId: null, pending: Buffer.alloc(0), fragment: null, count: 0, rateAt: Date.now() };
  clients.add(client);
  function close() { if (!clients.has(client)) return; clients.delete(client); detach(client); }
  socket.on('close', close);
  socket.on('error', close);
  function onData(chunk) {
    client.pending = Buffer.concat([client.pending, chunk]);
    if (client.pending.length > 150_000) { socket.destroy(); return; }
    while (client.pending.length >= 2) {
      const b = client.pending;
      const fin = !!(b[0] & 0x80); const opcode = b[0] & 0x0f; const masked = !!(b[1] & 0x80);
      let len = b[1] & 127; let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > 65536n) { socket.destroy(); return; } len = Number(big); off = 10; }
      if (!masked || len > 65536) { socket.destroy(); return; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4); off += 4;
      const payload = Buffer.from(b.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      client.pending = b.subarray(off + len);
      if (opcode === 8) { sendFrame(socket, 8, ''); socket.end(); return; }
      if (opcode === 9) { sendFrame(socket, 10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 && fin) { consume(payload); continue; }
      if (opcode === 1 && !fin) { client.fragment = payload; continue; }
      if (opcode === 0 && client.fragment) {
        client.fragment = Buffer.concat([client.fragment, payload]);
        if (client.fragment.length > 65536) { socket.destroy(); return; }
        if (fin) { consume(client.fragment); client.fragment = null; }
        continue;
      }
      socket.destroy(); return;
    }
  }
  function consume(payload) {
    const now = Date.now();
    if (now - client.rateAt > 1000) { client.rateAt = now; client.count = 0; }
    if (++client.count > 25) { err(client, 'Too many requests.'); return; }
    try { action(client, JSON.parse(payload.toString('utf8'))); }
    catch (e) { err(client, e.message); }
  }
  socket.on('data', onData);
  if (head?.length) onData(head);
});

const ticker = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (G.tick(room, now)) broadcast(room);
    if (room.emptySince && now - room.emptySince > 30 * 60_000) rooms.delete(code);
  }
}, 1000);
ticker.unref();
if (require.main === module) server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  LUDO REWIRED is running at http://localhost:${PORT}`);
  console.log('  Open the same URL in another tab for a quick two-player test.\n');
});
module.exports = { server, rooms };
