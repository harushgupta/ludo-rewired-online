'use strict';
const crypto = require('node:crypto');

const MAX_PLAYERS = 8;
const TOKEN_COUNT = 3;
const TRACK_LENGTH = 64;
const FINISH_PROGRESS = 69; // 64 ring positions + 5 private finish-lane positions
const DANGER_CELLS = [4, 12, 20, 28, 36, 44, 52, 60];
const SAFE_CELLS = [0, 8, 16, 24, 32, 40, 48, 56];
const TURN_MS = 45_000;
const SHIELD_MS = 25_000;
const REVERSE_TURNS = 8;
const COLOURS = ['#f16752', '#e7a53c', '#8aba69', '#42b49d', '#a68bea', '#e475af', '#bb8661', '#7b9ba2'];
const POWER_TYPES = ['extra', 'shield', 'lifeline', 'boost', 'purge'];

function die() { return crypto.randomInt(1, 7); }
function token() { return { progress: -1, dangerTurns: null, shieldUntil: 0, lifeline: false }; }
function newRoom(code, intervalSeconds = 90) {
  return {
    code, phase: 'lobby', hostId: null, players: [], turnIndex: 0,
    turnStartedAt: 0, turnEndsAt: 0, nextResetAt: 0,
    resetIntervalMs: intervalSeconds * 1000, roll: null, bonusTurn: false,
    reverse: { triggered: false, remaining: 0 }, winnerId: null,
    events: [], updatedAt: Date.now(), turnNumber: 0,
  };
}
function newPlayer(id, name, slot, secret) {
  const clean = String(name || '').trim().slice(0, 20);
  if (!clean) throw new Error('Please enter a player name.');
  return { id, secret, name: clean, slot,
    connected: false, tokens: Array.from({ length: TOKEN_COUNT }, token) };
}
function record(room, message, kind = 'info') {
  room.events.unshift({ id: crypto.randomUUID(), at: Date.now(), message, kind });
  room.events.length = Math.min(room.events.length, 24);
  room.updatedAt = Date.now();
}
function addPlayer(room, name) {
  if (room.phase !== 'lobby') throw new Error('This game has already started.');
  if (room.players.length >= MAX_PLAYERS) throw new Error('Room is full (8 players).');
  const used = new Set(room.players.map(p => p.slot));
  const slot = Array.from({ length: 8 }, (_, i) => i).find(i => !used.has(i));
  const player = newPlayer(crypto.randomUUID(), name, slot, crypto.randomBytes(24).toString('hex'));
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  record(room, `${player.name} joined the table.`, 'join');
  return player;
}
function start(room, requesterId, now = Date.now()) {
  if (room.hostId !== requesterId) throw new Error('Only the room host can start the game.');
  if (room.phase !== 'lobby') throw new Error('Game has already started.');
  if (room.players.length < 2) throw new Error('At least 2 players are required. Open the link in another tab to test.');
  room.players.forEach(p => { p.tokens = Array.from({ length: TOKEN_COUNT }, token); });
  room.phase = 'playing';
  room.turnIndex = 0;
  room.turnStartedAt = now;
  room.turnEndsAt = now + TURN_MS;
  room.nextResetAt = now + room.resetIntervalMs;
  room.reverse = { triggered: false, remaining: 0 };
  room.turnNumber = 1;
  room.winnerId = null;
  room.roll = null;
  room.bonusTurn = false;
  record(room, `Game started! ${room.players[0].name} goes first.`, 'start');
}
function currentPlayer(room) { return room.players[room.turnIndex]; }
function assertTurn(room, playerId) {
  if (room.phase !== 'playing') throw new Error('The game is not in progress.');
  if (currentPlayer(room)?.id !== playerId) throw new Error('It is not your turn.');
}
function rolling(room, playerId, forcedDice) {
  assertTurn(room, playerId);
  if (room.roll) throw new Error('You have already rolled. Choose a token.');
  const dice = forcedDice || [die(), die()];
  if (dice.length !== 2 || dice.some(d => !Number.isInteger(d) || d < 1 || d > 6)) throw new Error('Invalid dice.');
  room.roll = { dice, powerRequired: dice[0] === dice[1], powerChosen: dice[0] !== dice[1], boost: 0 };
  record(room, `${currentPlayer(room).name} rolled ${dice[0]} + ${dice[1]}${dice[0] === dice[1] ? ' — doubles! Choose a power.' : '.'}`, 'roll');
}
function choosePower(room, playerId, power, tokenIndex, now = Date.now()) {
  assertTurn(room, playerId);
  if (!room.roll?.powerRequired || room.roll.powerChosen) throw new Error('No power is waiting to be selected.');
  if (!POWER_TYPES.includes(power)) throw new Error('Unknown power.');
  const player = currentPlayer(room);
  const selected = player.tokens[tokenIndex];
  if (power === 'lifeline') {
    if (!Number.isInteger(tokenIndex) || !selected || selected.progress >= FINISH_PROGRESS) throw new Error('Choose a token to protect.');
    selected.lifeline = true;
  } else if (power === 'extra') {
    room.bonusTurn = true;
  } else if (power === 'shield') {
    for (const t of player.tokens) if (t.progress >= 0 && t.progress < FINISH_PROGRESS) t.shieldUntil = now + SHIELD_MS;
  } else if (power === 'boost') {
    room.roll.boost = 2;
  } else if (power === 'purge') {
    for (const t of player.tokens) t.dangerTurns = null;
  }
  room.roll.powerChosen = true;
  const labels = { extra: 'Extra Turn', shield: '25-second Shield', lifeline: 'Lifeline', boost: '+2 Boost', purge: 'Danger Cleanse' };
  record(room, `${player.name} selected ${labels[power]}!`, 'power');
}
function stepsFor(roll, mode) {
  if (!roll) return null;
  const d = roll.dice;
  if (mode === 'one') return d[0] + roll.boost;
  if (mode === 'two') return d[1] + roll.boost;
  if (mode === 'both') return d[0] + d[1] + roll.boost;
  return null;
}
function canLaunch(roll, mode) {
  return (mode === 'one' && roll.dice[0] === 6) ||
    (mode === 'two' && roll.dice[1] === 6) ||
    (mode === 'both' && roll.dice.includes(6));
}
function getLegalMoves(room, playerId, mode) {
  const player = room.players.find(p => p.id === playerId);
  if (!player || room.phase !== 'playing' || currentPlayer(room).id !== playerId || !room.roll?.powerChosen) return [];
  const steps = stepsFor(room.roll, mode);
  if (steps == null) return [];
  return player.tokens.flatMap((t, i) => {
    if (t.progress >= FINISH_PROGRESS) return [];
    if (t.progress === -1) return room.reverse.remaining === 0 && canLaunch(room.roll, mode) ? [i] : [];
    if (room.reverse.remaining > 0 && t.progress === 0) return [];
    return [i];
  });
}
function allLegal(room, playerId) {
  return ['one', 'two', 'both'].flatMap(mode => getLegalMoves(room, playerId, mode));
}
function positionOnRing(player, t) {
  if (t.progress < 0 || t.progress >= TRACK_LENGTH) return -1;
  return (player.slot * 8 + t.progress) % TRACK_LENGTH;
}
function protectedFromReset(t, now) {
  if (t.shieldUntil > now) return true;
  if (t.lifeline) { t.lifeline = false; return true; }
  return false;
}
function knockHome(room, p, t, cause, now) {
  if (protectedFromReset(t, now)) {
    t.dangerTurns = null;
    record(room, `${p.name}'s protection blocked ${cause}.`, 'shield');
    return false;
  }
  t.progress = -1;
  t.dangerTurns = null;
  t.shieldUntil = 0;
  record(room, `${p.name} lost a token to ${cause} — back to base!`, 'danger');
  return true;
}
function resolveDanger(room, player, movedIndex, now) {
  player.tokens.forEach((t, index) => {
    if (index === movedIndex) {
      const pos = positionOnRing(player, t);
      t.dangerTurns = DANGER_CELLS.includes(pos) ? 2 : null;
    } else if (t.dangerTurns !== null && t.progress >= 0 && t.progress < TRACK_LENGTH) {
      t.dangerTurns -= 1;
      if (t.dangerTurns <= 0) knockHome(room, player, t, 'a danger zone', now);
    }
  });
}
function captureEnemies(room, mover, moved, now) {
  const ring = positionOnRing(mover, moved);
  if (ring < 0 || SAFE_CELLS.includes(ring)) return;
  for (const p of room.players) {
    if (p.id === mover.id) continue;
    for (const t of p.tokens) {
      if (positionOnRing(p, t) === ring) knockHome(room, p, t, `${mover.name}'s capture`, now);
    }
  }
}
function advance(room, now, useBonus = true) {
  const previous = currentPlayer(room);
  const bonus = room.bonusTurn && useBonus;
  room.bonusTurn = false;
  room.roll = null;
  if (!bonus) room.turnIndex = (room.turnIndex + 1) % room.players.length;
  room.turnNumber++;
  room.turnStartedAt = now;
  room.turnEndsAt = now + TURN_MS;
  if (bonus) record(room, `${previous.name} gets an extra turn!`, 'power');
}
function spendReverseTurn(room) {
  if (!room.reverse.remaining) return;
  room.reverse.remaining--;
  if (room.reverse.remaining === 0) record(room, 'Reverse Mode ended. Forward movement resumes!', 'reverse');
}
function move(room, playerId, tokenIndex, mode, now = Date.now()) {
  assertTurn(room, playerId);
  if (!room.roll?.powerChosen) throw new Error('Roll dice and select your doubles power first.');
  if (!Number.isInteger(tokenIndex) || !getLegalMoves(room, playerId, mode).includes(tokenIndex)) throw new Error('That token cannot use this dice choice.');
  const player = currentPlayer(room);
  const t = player.tokens[tokenIndex];
  const steps = stepsFor(room.roll, mode);
  const inReverse = room.reverse.remaining > 0;
  if (t.progress < 0) t.progress = 0;
  else t.progress = inReverse ? Math.max(0, t.progress - steps) : Math.min(FINISH_PROGRESS, t.progress + steps);
  resolveDanger(room, player, tokenIndex, now);
  captureEnemies(room, player, t, now);
  const cell = positionOnRing(player, t);
  record(room, `${player.name} moved token ${tokenIndex + 1} ${inReverse ? 'back' : 'forward'} ${steps} using ${mode === 'both' ? 'both dice' : `die ${mode === 'one' ? 1 : 2}`}.${cell >= 0 && DANGER_CELLS.includes(cell) ? ' Danger zone: 2 moves to escape!' : ''}`, 'move');
  if (t.progress === FINISH_PROGRESS) record(room, `${player.name} brought token ${tokenIndex + 1} to the finish!`, 'finish');
  if (player.tokens.every(x => x.progress >= FINISH_PROGRESS)) {
    room.phase = 'finished'; room.winnerId = playerId; room.roll = null;
    record(room, `🏆 ${player.name} wins the game!`, 'win');
    return;
  }
  const wasReverse = inReverse;
  if (!room.reverse.triggered && room.players.some(p => p.tokens.filter(x => x.progress >= FINISH_PROGRESS).length >= 2)) {
    room.reverse.triggered = true;
    room.reverse.remaining = REVERSE_TURNS;
    record(room, `⚡ Reverse Mode! For the next ${REVERSE_TURNS} turns, tokens move backward!`, 'reverse');
  }
  if (wasReverse) spendReverseTurn(room);
  advance(room, now);
}
function pass(room, playerId, now = Date.now()) {
  assertTurn(room, playerId);
  if (!room.roll?.powerChosen) throw new Error('Roll dice and choose a power first.');
  if (allLegal(room, playerId).length) throw new Error('You have a legal move. Select a token to play.');
  const p = currentPlayer(room);
  resolveDanger(room, p, -1, now);
  record(room, `${p.name} has no legal moves and passes.`, 'move');
  spendReverseTurn(room);
  advance(room, now);
}
function resetInterval(room, now = Date.now()) {
  if (room.phase !== 'playing') return;
  for (const p of room.players) {
    const active = p.tokens.filter(t => t.progress >= 0 && t.progress < FINISH_PROGRESS);
    if (active.length) {
      const target = active.sort((a, b) => b.progress - a.progress)[0];
      knockHome(room, p, target, 'the chaos countdown', now);
    }
  }
  record(room, '⏱ CHAOS RESET! One leading active token per team was targeted.', 'reset');
  room.nextResetAt = now + room.resetIntervalMs;
}
function tick(room, now = Date.now()) {
  if (room.phase !== 'playing') return false;
  let modified = false;
  if (now >= room.nextResetAt) { resetInterval(room, now); modified = true; }
  if (now >= room.turnEndsAt) {
    const p = currentPlayer(room);
    // The danger countdown applies to the current player's turn even on a timeout.
    resolveDanger(room, p, -1, now);
    record(room, `${p.name}'s 45-second turn timer expired.`, 'timeout');
    spendReverseTurn(room);
    advance(room, now, false);
    modified = true;
  }
  return modified;
}
function rematch(room, playerId) {
  if (room.hostId !== playerId) throw new Error('Only the host can request a rematch.');
  if (room.phase !== 'finished') throw new Error('Finish the current game before a rematch.');
  room.phase = 'lobby';
  room.roll = null;
  room.bonusTurn = false;
  room.reverse = { triggered: false, remaining: 0 };
  room.winnerId = null;
  room.turnIndex = 0;
  for (const p of room.players) p.tokens = Array.from({length: TOKEN_COUNT}, token);
  record(room, 'Rematch lobby is open. The host can start again!', 'start');
}
function publicState(room, playerId, now = Date.now()) {
  return {
    type: 'state', serverNow: now, code: room.code, phase: room.phase,
    hostId: room.hostId, you: playerId, turnPlayerId: currentPlayer(room)?.id,
    turnEndsAt: room.turnEndsAt, nextResetAt: room.nextResetAt,
    resetIntervalMs: room.resetIntervalMs, turnNumber: room.turnNumber,
    players: room.players.map(p => ({ id: p.id, name: p.name, slot: p.slot,
      connected: p.connected, color: COLOURS[p.slot], tokens: p.tokens.map(t => ({ ...t })) })),
    roll: room.roll && { ...room.roll }, reverse: { ...room.reverse },
    events: room.events.slice(0, 12), winnerId: room.winnerId,
    legal: { one: getLegalMoves(room, playerId, 'one'), two: getLegalMoves(room, playerId, 'two'), both: getLegalMoves(room, playerId, 'both') },
  };
}
module.exports = {
  MAX_PLAYERS, TOKEN_COUNT, TRACK_LENGTH, FINISH_PROGRESS, DANGER_CELLS, SAFE_CELLS,
  TURN_MS, SHIELD_MS, REVERSE_TURNS, COLOURS, POWER_TYPES,
  newRoom, addPlayer, start, rolling, choosePower, getLegalMoves, allLegal,
  move, pass, tick, resetInterval, rematch, publicState, record, currentPlayer, positionOnRing,
};
