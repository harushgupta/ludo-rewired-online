'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

function setup(interval=90) {
  const room = G.newRoom('ABCDEF', interval);
  const a = G.addPlayer(room, 'Alice');
  const b = G.addPlayer(room, 'Bob');
  a.connected = b.connected = true;
  G.start(room, a.id, 1000);
  return { room, a, b };
}
function rollMove(room, player, dice, mode, idx, now=2000, power='extra') {
  G.rolling(room, player.id, dice);
  if (dice[0] === dice[1]) G.choosePower(room, player.id, power, 0, now);
  G.move(room, player.id, idx, mode, now);
}
test('room supports exactly eight players and cannot start with one', () => {
  const r = G.newRoom('ABCDEF');
  const a = G.addPlayer(r, 'Alpha');
  assert.throws(() => G.start(r,a.id), /At least 2/);
  for(let i=1;i<8;i++)G.addPlayer(r,'Player '+i);
  assert.equal(r.players.length, 8);
  assert.deepEqual(r.players.map(p=>p.slot),[0,1,2,3,4,5,6,7]);
  assert.throws(()=>G.addPlayer(r,'Extra'),/full/);
});
test('dice 1, dice 2 and both offer player choice; six launches a base token',()=>{
  const {room,a}=setup();
  G.rolling(room,a.id,[6,3]);
  assert.deepEqual(G.getLegalMoves(room,a.id,'one'),[0,1,2]);
  assert.deepEqual(G.getLegalMoves(room,a.id,'two'),[]);
  assert.deepEqual(G.getLegalMoves(room,a.id,'both'),[0,1,2]);
  G.move(room,a.id,0,'both',2000);
  assert.equal(a.tokens[0].progress,0);
  assert.equal(room.turnIndex,1);
});
test('doubles require a choice and extra-turn reward keeps player active',()=>{
  const {room,a}=setup();
  G.rolling(room,a.id,[6,6]);
  assert.deepEqual(G.getLegalMoves(room,a.id,'both'),[]);
  assert.throws(()=>G.move(room,a.id,0,'both'),/power/);
  G.choosePower(room,a.id,'extra',null,2000);
  G.move(room,a.id,0,'one',2000);
  assert.equal(room.turnIndex,0);
  assert.equal(room.roll,null);
  assert.equal(a.tokens[0].progress,0);
});
test('landing on a danger tile gives two following personal turns to escape',()=>{
  const {room,a,b}=setup();
  a.tokens[0].progress=3; // player zero moves 1 to danger cell 4
  rollMove(room,a,[1,2],'one',0,2000);
  assert.equal(a.tokens[0].dangerTurns,2);
  G.rolling(room,b.id,[1,2]); G.pass(room,b.id,2100); // Bob has no tokens outside base
  G.rolling(room,a.id,[1,2]);
  assert.deepEqual(G.getLegalMoves(room,a.id,'one'),[0]);
  assert.throws(()=>G.pass(room,a.id),/legal move/);
  // Alice chooses not to rescue token 0: move another token already outside.
  a.tokens[1].progress=15;
  G.move(room,a.id,1,'one',2200);
  assert.equal(a.tokens[0].dangerTurns,1);
  G.rolling(room,b.id,[1,2]); G.pass(room,b.id,2300);
  G.rolling(room,a.id,[1,2]); G.move(room,a.id,1,'one',2400);
  assert.equal(a.tokens[0].progress,-1);
  assert.equal(a.tokens[0].dangerTurns,null);
});
test('a token can escape danger with its next turn',()=>{
  const {room,a}=setup();
  a.tokens[0].progress=3;
  rollMove(room,a,[1,2],'one',0);
  room.turnIndex=0;room.roll=null;
  G.rolling(room,a.id,[2,4]);
  G.move(room,a.id,0,'both',3000);
  assert.equal(a.tokens[0].progress,10);
  assert.equal(a.tokens[0].dangerTurns,null);
});
test('chaos interval targets one active token per team and lifelines block it',()=>{
  const {room,a,b}=setup();
  a.tokens[0].progress=20;
  a.tokens[1].progress=5;
  b.tokens[0].progress=30;
  a.tokens[0].lifeline=true;
  G.resetInterval(room,100000);
  assert.equal(a.tokens[0].progress,20);
  assert.equal(a.tokens[0].lifeline,false);
  assert.equal(a.tokens[1].progress,5);
  assert.equal(b.tokens[0].progress,-1);
  assert.equal(room.nextResetAt,190000);
});
test('shield blocks captures and expires, while lifeline blocks one capture',()=>{
  const {room,a,b}=setup();
  a.tokens[0].progress=9; // global ring 9
  b.tokens[0].progress=2; // global ring 10
  b.tokens[0].shieldUntil=20000;
  G.rolling(room,a.id,[1,2]);G.move(room,a.id,0,'one',3000);
  assert.equal(b.tokens[0].progress,2);
  a.tokens[0].progress=9; room.turnIndex=0;
  G.rolling(room,a.id,[1,3]);G.move(room,a.id,0,'one',30000);
  assert.equal(b.tokens[0].progress,-1);
});
test('reaching two finished tokens triggers eight reverse moves',()=>{
  const {room,a,b}=setup();
  a.tokens[0].progress=69;
  a.tokens[1].progress=68;
  a.tokens[2].progress=18;
  G.rolling(room,a.id,[1,3]);G.move(room,a.id,1,'one',2000);
  assert.equal(room.reverse.remaining,8);
  assert.equal(room.reverse.triggered,true);
  b.tokens[0].progress=20;
  G.rolling(room,b.id,[3,4]);G.move(room,b.id,0,'one',2100);
  assert.equal(b.tokens[0].progress,17);
  assert.equal(room.reverse.remaining,7);
  for(let i=0;i<7;i++){
    const p=G.currentPlayer(room);
    if(p.tokens[2].progress<0)p.tokens[2].progress=45;
    G.rolling(room,p.id,[1,2]);G.move(room,p.id,2,'one',2200+i);
  }
  assert.equal(room.reverse.remaining,0);
});
test('finishing all three tokens ends game and host can request rematch',()=>{
  const {room,a}=setup();
  a.tokens[0].progress=69;a.tokens[1].progress=69;a.tokens[2].progress=68;
  G.rolling(room,a.id,[1,2]);G.move(room,a.id,2,'one',2000);
  assert.equal(room.phase,'finished');assert.equal(room.winnerId,a.id);
  G.rematch(room,a.id);
  assert.equal(room.phase,'lobby');assert.equal(a.tokens[0].progress,-1);
});
test('timeout advances automatically and scheduled reset triggers',()=>{
  const {room,a}=setup(60);
  a.tokens[0].progress=8;
  assert.equal(G.tick(room,61001),true);
  assert.equal(a.tokens[0].progress,-1);
  assert.equal(room.turnIndex,1);
  assert.equal(room.turnEndsAt,106001);
});
