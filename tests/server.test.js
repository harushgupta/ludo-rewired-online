'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {server}=require('../server');

function connected(url) {
  return new Promise((resolve,reject)=>{
    const ws = new WebSocket(url);
    ws.queue=[];
    ws.addEventListener('open',()=>resolve(ws),{once:true});
    ws.addEventListener('message',e=>{
      const data=JSON.parse(e.data);
      const waiter=ws.waiter;
      if(waiter && waiter.test(data)) {ws.waiter=null;clearTimeout(waiter.timeout);waiter.resolve(data);}
      else ws.queue.push(data);
    });
    ws.addEventListener('error',e=>reject(new Error('Socket failed to connect')),{once:true});
  });
}
function waitFor(ws, test) {
  const idx=ws.queue.findIndex(test);
  if(idx!==-1) return Promise.resolve(ws.queue.splice(idx,1)[0]);
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{ws.waiter=null;reject(new Error('Timed out waiting for message'));},3000);
    ws.waiter={test,timeout,resolve};
  });
}
function send(ws,obj){ws.send(JSON.stringify(obj));}
test('real WebSocket server creates private rooms, joins players, starts a shared game and enforces turns',async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`ws://127.0.0.1:${server.address().port}/socket`;
  const host=await connected(url);
  const guest=await connected(url);
  try {
    // Hosted HTTPS pages use secure WebSockets; lightweight app pings must work
    // before joining a room as well as during active matches.
    send(host, {type:'ping'});
    const pong = await waitFor(host, m=>m.type==='pong');
    assert.equal(typeof pong.serverNow, 'number');
    const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    send(host,{type:'create',name:'Host Player',interval:60});
    const hostId=await waitFor(host,m=>m.type==='identity');
    assert.match(hostId.code,/^[A-HJ-NP-Z2-9]{6}$/);
    const lobby1=await waitFor(host,m=>m.type==='state' && m.players.length===1);
    assert.equal(lobby1.phase,'lobby');
    send(guest,{type:'join',name:'Guest',code:hostId.code});
    const guestId=await waitFor(guest,m=>m.type==='identity');
    assert.equal(guestId.code,hostId.code);
    const lobby2=await waitFor(host,m=>m.type==='state' && m.players.length===2);
    assert.equal(lobby2.players.filter(p=>p.connected).length,2);
    send(guest,{type:'start'});
    const startErr=await waitFor(guest,m=>m.type==='error');
    assert.match(startErr.message,/host/);
    send(host,{type:'start'});
    const playing=await waitFor(host,m=>m.type==='state' && m.phase==='playing');
    assert.equal(playing.players.length,2);
    assert.equal(playing.resetIntervalMs,60000);
    send(guest,{type:'roll'});
    const wrongTurn=await waitFor(guest,m=>m.type==='error');
    assert.match(wrongTurn.message,/not your turn/);
    send(host,{type:'roll'});
    const rolled=await waitFor(host,m=>m.type==='state' && m.roll!==null);
    assert.ok(rolled.roll.dice.every(n=>n>=1 && n<=6));
    assert.equal(rolled.roll.dice.length,2);
  } finally {host.close();guest.close();await new Promise(resolve=>server.close(resolve));}
});
