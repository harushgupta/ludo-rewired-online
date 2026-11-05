(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const TRACK = 64, FINISH = 69, CX = 400, CY = 400, RR = 280;
  const DANGER = new Set([4, 12, 20, 28, 36, 44, 52, 60]);
  const SAFE = new Set([0, 8, 16, 24, 32, 40, 48, 56]);
  const PALETTE = ['#f16752', '#e7a53c', '#8aba69', '#42b49d', '#a68bea', '#e475af', '#bb8661', '#7b9ba2'];
  const powerInfo = [
    { key:'extra', icon:'↻', title:'Extra turn', help:'Play again after this move' },
    { key:'shield', icon:'◈', title:'Shield', help:'Protect active tokens 25s' },
    { key:'lifeline', icon:'♥', title:'Save a token', help:'Block one loss' },
    { key:'boost', icon:'⚡', title:'+2 dash', help:'Move two extra spaces' },
    { key:'purge', icon:'✦', title:'Danger cleanse', help:'Clear danger counters' },
  ];
  let state = null, socket = null, connected = false, selectedMode = 'both', selectingLifeline = false;
  let lastTurnKey = '', toastTimeout, retryTimeout, clockSkew = 0, resumeWaiting = false;
  const sessionKey = 'ludo-rewired-room';
  const getSession = () => { try { return JSON.parse(sessionStorage.getItem(sessionKey)); } catch { return null; } };
  const escapeHTML = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function notice(message, error = false) {
    const n = $('toast'); n.textContent = message; n.classList.toggle('error', error); n.classList.remove('hidden');
    clearTimeout(toastTimeout); toastTimeout = setTimeout(() => n.classList.add('hidden'), 3600);
  }
  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) { notice('Not connected to the server. Reconnecting…', true); return; }
    socket.send(JSON.stringify(payload));
  }
  function netStatus(online) {
    connected = online; $('netDot').classList.toggle('ok', online);
    $('netText').textContent = online ? 'Live multiplayer' : 'Offline / reconnecting';
    for (const id of ['createBtn', 'joinBtn']) $(id).disabled = !online;
  }
  function connect() {
    clearTimeout(retryTimeout);
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
    socket.addEventListener('open', () => {
      netStatus(true);
      const sess = getSession();
      if (sess?.code && sess?.playerId && sess?.secret) { resumeWaiting = true; send({ type:'resume', ...sess }); }
    });
    socket.addEventListener('message', ({ data }) => {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 'identity') {
        resumeWaiting = false;
        sessionStorage.setItem(sessionKey, JSON.stringify({ code:m.code, playerId:m.playerId, secret:m.secret }));
        if (m.code) { const u = new URL(location.href); u.searchParams.set('room', m.code); history.replaceState(null, '', u); }
      } else if (m.type === 'state') {
        clockSkew = m.serverNow - Date.now();
        state = m;
        render();
      } else if (m.type === 'error') {
        notice(m.message, true);
      } else if (m.type === 'resumeFailed') {
        resumeWaiting = false; sessionStorage.removeItem(sessionKey); state = null;
        show('welcomeView'); notice(m.message, true);
      } else if (m.type === 'left') {
        sessionStorage.removeItem(sessionKey); state = null;
        history.replaceState(null, '', location.pathname); show('welcomeView');
      }
    });
    socket.addEventListener('close', () => {
      netStatus(false);
      if (!state) $('netText').textContent = 'Server unavailable';
      retryTimeout = setTimeout(connect, 1400);
    });
    socket.addEventListener('error', () => { /* close handles reconnect */ });
  }
  function show(id) {
    ['welcomeView','lobbyView','gameView'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  }
  function getMe() { return state?.players.find(p => p.id === state.you); }
  function current() { return state?.players.find(p => p.id === state.turnPlayerId); }
  const finished = t => t.progress >= FINISH;
  const inBase = t => t.progress < 0;
  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { show('lobbyView'); renderLobby(); return; }
    show('gameView'); renderGame();
  }
  function renderLobby() {
    const me = getMe();
    $('lobbyCode').textContent = state.code;
    $('lobbyCount').textContent = `${state.players.length} / 8`;
    const list = [...state.players].sort((a,b) => a.slot-b.slot);
    let html = list.map(p => `<div class="lobby-seat"><div class="seat-avatar" style="background:${p.color}">${escapeHTML(p.name[0].toUpperCase())}</div><div><div class="lobby-seat-name">${escapeHTML(p.name)}${p.id === state.you ? ' <span style="color:#f0b287">(you)</span>' : ''}</div><div class="lobby-seat-meta">PLAYER ${p.slot+1}${p.id === state.hostId ? ' · HOST 👑' : ''}</div></div><i class="seat-online" style="background:${p.connected ? '#94c996' : '#a77f86'}"></i></div>`).join('');
    for(let i=list.length; i<8; i++) html += `<div class="lobby-seat empty"><div class="seat-avatar" style="background:#766779">+</div><div><div class="lobby-seat-name">Empty seat</div><div class="lobby-seat-meta">AWAITING PLAYER</div></div></div>`;
    $('lobbyPlayers').innerHTML = html;
    $('resetSelect').value = String(state.resetIntervalMs/1000);
    $('resetSelect').disabled = me?.id !== state.hostId;
    $('startBtn').disabled = me?.id !== state.hostId || state.players.length < 2;
    $('startBtn').innerHTML = me?.id !== state.hostId ? 'Waiting for host to start…' : 'Start the chaos <span>↗</span>';
    $('startHint').textContent = state.players.length < 2 ? 'At least 2 players needed to begin.' : me?.id === state.hostId ? `${state.players.length} players ready. You can start now!` : 'The host will start when everyone is ready.';
  }
  function renderGame() {
    const me=getMe(), turn=current();
    $('gameCode').textContent=`CODE ${state.code}`;
    $('gameTitle').textContent = state.phase === 'finished' ? 'A winner emerges.' : 'It\'s game time.';
    $('gamePlayerCount').textContent=`${state.players.length} / 8`;
    $('boardCounter').textContent = `TURN ${String(state.turnNumber||1).padStart(2,'0')}`;
    $('boardMode').textContent = state.reverse.remaining>0 ? `⚡ REVERSE MODE · ${state.reverse.remaining} LEFT` : '● NORMAL PLAY';
    $('boardMode').classList.toggle('reversed', state.reverse.remaining>0);
    const turnKey = `${state.turnPlayerId}:${state.turnNumber}:${state.roll?.dice.join('-') || 'unrolled'}`;
    if (lastTurnKey !== turnKey) { selectedMode='both'; selectingLifeline=false; lastTurnKey=turnKey; }
    renderBoard();
    renderAction(me, turn);
    renderScore();
    renderLog();
    updateClocks();
  }
  function fmt(sec){const s=Math.max(0,Math.ceil(sec));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
  function updateClocks() {
    if (!state || state.phase !== 'playing') {
      $('resetTimer').textContent='--:--'; $('turnTimer').textContent='--:--';return;
    }
    const now=Date.now()+clockSkew;
    const reset=Math.max(0,(state.nextResetAt-now)/1000),turn=Math.max(0,(state.turnEndsAt-now)/1000);
    $('resetTimer').textContent=fmt(reset); $('turnTimer').textContent=fmt(turn);
    $('resetBar').style.width=`${Math.min(100,Math.max(0,reset/(state.resetIntervalMs/1000)*100))}%`;
    $('turnBar').style.width=`${Math.min(100,Math.max(0,turn/45*100))}%`;
  }
  function diceHtml(n){
    const spots={1:[4],2:[0,8],3:[0,4,8],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};
    return `<div class="die-box" aria-label="Dice shows ${n}">${Array.from({length:9},(_,i)=>`<i class="pip ${spots[n].includes(i)?'':'off'}"></i>`).join('')}</div>`;
  }
  function renderAction(me, turn) {
    const isTurn=state.phase==='playing' && me?.id===turn?.id;
    $('turnChip').textContent = state.phase==='finished' ? 'GAME OVER' : isTurn ? 'YOUR TURN' : 'WAITING';
    $('turnChip').classList.toggle('active', isTurn);
    $('turnInfo').innerHTML = state.phase==='finished' ? `<strong>${escapeHTML(state.players.find(p=>p.id===state.winnerId)?.name || 'A player')} wins!</strong> All three tokens finished.` : isTurn ? `<strong>You're up, ${escapeHTML(me.name)}!</strong> ${state.reverse.remaining ? 'Moves go backwards while reverse mode is active.' : 'Roll, choose your dice and move a token.'}` : `<strong>${escapeHTML(turn?.name || 'Player')}'s turn.</strong> Follow their move live, then prepare for yours.`;
    const area=$('actionArea');
    if (state.phase==='finished') {
      area.innerHTML = `<div class="waiting-message">🏆 The match is complete!<br>Ready for another?</div>${me.id===state.hostId ? '<button class="primary-button roll-button" data-action="rematch" style="margin-top:12px">Play again ↻</button>' : '<p class="select-help">The host can start a rematch.</p>'}`;
      return;
    }
    if (!isTurn) { area.innerHTML='<div class="waiting-message">✳ &nbsp; Spectating this round.<br>Watch the board for sudden twists!</div>'; return; }
    if (!state.roll) { area.innerHTML='<button class="primary-button roll-button" data-action="roll">⚄ &nbsp; ROLL TWO DICE &nbsp; ⚅</button><p class="select-help">Two dice are rolled every turn. Then choose die 1, die 2 or both.</p>';return; }
    let html = `<div class="dice-row">${diceHtml(state.roll.dice[0])}${diceHtml(state.roll.dice[1])}</div><div class="dice-caption">DIE 1 : ${state.roll.dice[0]} &nbsp; · &nbsp; DIE 2 : ${state.roll.dice[1]}</div>`;
    if (state.roll.powerRequired && !state.roll.powerChosen) {
      html += '<div class="power-banner">✦ &nbsp; DOUBLES! CHOOSE YOUR POWER</div>';
      if (selectingLifeline) {
        html += '<p class="select-help">Choose which token gets one-use protection against a reset or capture.</p><div class="token-chooser">';
        me.tokens.forEach((t,i)=>{if(!finished(t)) html += `<button data-power="lifeline" data-token-index="${i}">Token ${i+1}${t.lifeline?' ♥':''}</button>`;});
        html+='</div><button class="power-back" data-action="powerBack">← Back to powers</button>';
      } else {
        html += `<div class="power-grid">${powerInfo.map(p=>`<button class="power-option" data-power="${p.key}"><b>${p.icon}</b><span>${p.title}<small style="display:block;font-size:9px;color:#c6b1c2;font-weight:500;margin-top:4px">${p.help}</small></span></button>`).join('')}</div>`;
      }
      area.innerHTML=html;return;
    }
    const dice=state.roll.dice, boost=state.roll.boost||0;
    const modes=[{key:'one',label:'Die 1',steps:dice[0]+boost},{key:'two',label:'Die 2',steps:dice[1]+boost},{key:'both',label:'Both dice',steps:dice[0]+dice[1]+boost}];
    html+='<div class="modes">'+modes.map(m=>`<button class="mode-button ${selectedMode===m.key?'selected':''}" data-mode="${m.key}">${m.label}<span>${m.steps}</span></button>`).join('')+'</div>';
    const choices=state.legal[selectedMode] || [];
    const possible=Object.values(state.legal).some(arr=>arr.length>0);
    if (choices.length) html+=`<p class="select-help">✦ &nbsp; Selected: <strong>${selectedMode==='both'?'both dice':selectedMode==='one'?'die 1':'die 2'}</strong>. Click a glowing token on the board to move ${modes.find(m=>m.key===selectedMode).steps} spaces.</p>`;
    else if(possible) html+='<p class="select-help">No legal token for this dice choice. Try selecting another die.</p>';
    else html+='<p class="select-help">No legal moves for this roll. Pass and wait for your next turn.</p><button class="skip-button" data-action="pass">Pass turn →</button>';
    if (state.reverse.remaining) html += '<div class="power-banner" style="margin-top:12px">⚡ &nbsp; REVERSE MOVEMENT ACTIVE</div>';
    area.innerHTML=html;
  }
  function renderScore() {
    $('scorePlayers').innerHTML=state.players.map(p=>{
      const done=p.tokens.filter(finished).length;
      const current=p.id===state.turnPlayerId && state.phase==='playing';
      return `<div class="score-item ${current?'current':''}"><div class="score-color" style="background:${p.color}"></div><div class="score-initial" style="background:${p.color}">${escapeHTML(p.name[0].toUpperCase())}</div><div class="score-details"><div class="score-name">${escapeHTML(p.name)}${p.id===state.you?' · YOU':''}${p.id===state.hostId?' 👑':''}</div><div class="score-sub">${p.connected?'● ONLINE':'○ OFFLINE'} · ${p.tokens.filter(t=>t.progress>=0&&t.progress<FINISH).length} ON BOARD</div></div><div class="score-stars">${[0,1,2].map(i=>`<span class="${i<done?'full':''}">★</span>`).join('')}</div></div>`;
    }).join('');
  }
  function renderLog(){
    $('eventLog').innerHTML=state.events.map(e=>`<div class="event-item ${escapeHTML(e.kind)}"><span class="event-symbol">${({roll:'⚄',move:'↗',power:'✦',danger:'!',reset:'⏱',reverse:'⚡',win:'🏆',timeout:'⌛'})[e.kind]||'•'}</span><div>${escapeHTML(e.message)}<span class="event-time">${new Date(e.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div></div>`).join('');
  }
  const ang = idx => -Math.PI/2 + 2*Math.PI*idx/TRACK;
  const point=(angle,dist)=>({x:CX+Math.cos(angle)*dist,y:CY+Math.sin(angle)*dist});
  const ringPoint=i=>point(ang(i),RR);
  const n=v=>Number(v).toFixed(2);
  function svgText(str){return escapeHTML(str);}
  function renderBoard(){
    const parts=[], me=getMe();
    const active=state.phase==='playing'&&state.turnPlayerId===state.you&&state.roll?.powerChosen;
    const allowed=new Set(active ? (state.legal[selectedMode]||[]) : []);
    const bg = `<defs><radialGradient id="halo" cx="50%" cy="50%" r="55%"><stop offset="0" stop-color="#584150"/><stop offset=".85" stop-color="#352635"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="7"/></filter></defs>`;
    parts.push(bg);
    parts.push('<circle cx="400" cy="400" r="342" fill="url(#halo)" stroke="#775465" stroke-width="2"/>');
    parts.push('<circle cx="400" cy="400" r="306" fill="none" stroke="#a37d7f" stroke-width="2" stroke-dasharray="5 9" opacity=".55"/>');
    parts.push('<circle cx="400" cy="400" r="250" fill="none" stroke="#a37d7f" stroke-width="2" stroke-dasharray="5 9" opacity=".4"/>');
    for (let s=0;s<8;s++){
      const a=ang(s*8), p1=point(a,85),p2=point(a,254);
      parts.push(`<path class="board-spoke" d="M${n(p1.x)} ${n(p1.y)}L${n(p2.x)} ${n(p2.y)}"/>`);
    }
    for(let i=0;i<TRACK;i++){
      const p=ringPoint(i),danger=DANGER.has(i),safe=SAFE.has(i),cls=danger?'danger':safe?'safe':'';
      parts.push(`<circle class="track-cell ${cls}" cx="${n(p.x)}" cy="${n(p.y)}" r="12.8"/>`);
      if(danger)parts.push(`<text x="${n(p.x)}" y="${n(p.y+4.0)}" fill="#fff7e7" font-size="11" font-weight="900" text-anchor="middle">!</text>`);
      if(safe)parts.push(`<text x="${n(p.x)}" y="${n(p.y+3.7)}" fill="#664c38" font-size="10" font-weight="900" text-anchor="middle">★</text>`);
    }
    for(let s=0;s<8;s++){
      const color=PALETTE[s],a=ang(s*8);
      for(let j=0;j<5;j++){
        const p=point(a,219-j*30);
        parts.push(`<circle class="lane-cell" cx="${n(p.x)}" cy="${n(p.y)}" r="12.7" fill="${color}" opacity="${n(.78+j*.045)}"/>`);
      }
    }
    parts.push('<circle cx="400" cy="400" r="70" fill="#2b202d" stroke="#ecab86" stroke-width="2.5"/>');
    for(let s=0;s<8;s++){
      const a1=ang(s*8),a2=ang((s+1)*8),p1=point(a1,66),p2=point(a2,66);
      parts.push(`<path d="M400 400L${n(p1.x)} ${n(p1.y)}A66 66 0 0 1 ${n(p2.x)} ${n(p2.y)}Z" fill="${PALETTE[s]}" opacity=".16"/>`);
    }
    parts.push('<text x="400" y="398" class="home-target">✳</text><text x="400" y="424" class="center-sub">FINISH</text>');
    for(const p of state.players){
      const a=ang(p.slot*8), seat=point(a,359), seatX=seat.x-51,seatY=seat.y-29;
      parts.push(`<g><rect x="${n(seatX)}" y="${n(seatY)}" width="102" height="62" rx="12" fill="#2b202c" stroke="${p.color}" stroke-width="2.3"/>`);
      parts.push(`<rect x="${n(seatX+8)}" y="${n(seatY+9)}" width="5" height="17" rx="2.5" fill="${p.color}"/>`);
      const short=p.name.length>11?p.name.slice(0,10)+'…':p.name;
      parts.push(`<text class="board-seat-name" x="${n(seat.x+1)}" y="${n(seat.y-13)}" text-anchor="middle">${svgText(short)}</text>`);
      parts.push(`<text class="board-seat-count" x="${n(seat.x)}" y="${n(seat.y)}" text-anchor="middle">${p.tokens.filter(finished).length}/3 FINISHED ${p.id===state.turnPlayerId&&state.phase==='playing'?'✦':''}</text>`);
      parts.push('</g>');
    }
    // Tokens are rendered on top of track spaces and private finish lanes.
    const occupied=new Map();
    for(const p of state.players){
      for(let i=0;i<p.tokens.length;i++){
        const t=p.tokens[i];let pos;
        if(inBase(t)){
          const seat=point(ang(p.slot*8),359);
          pos={x:seat.x+(i-1)*24,y:seat.y+17};
        }else if(finished(t)){
          pos=point(ang(p.slot*8),49);
        }else if(t.progress>=64){
          pos=point(ang(p.slot*8),219-(t.progress-64)*30);
        }else{
          pos=ringPoint((p.slot*8+t.progress)%TRACK);
        }
        const locKey=`${n(pos.x)}:${n(pos.y)}`;
        const already=occupied.get(locKey)||0;occupied.set(locKey,already+1);
        const offsets=[[0,0],[-8,-7],[8,7],[-9,8],[8,-9],[0,-12],[12,0],[-12,0]];
        const offset=offsets[Math.min(7,already)];
        parts.push({p,t,i,x:pos.x+offset[0],y:pos.y+offset[1]});
      }
    }
    // Add clickable token groups only after all fixed board elements.
    for(const item of parts.filter(x=>typeof x==='object')){
      const {p,t,i,x,y}=item;const playable=active&&p.id===state.you&&allowed.has(i);
      const shield=t.shieldUntil>Date.now()+clockSkew,life=t.lifeline,danger=t.dangerTurns!==null;
      if(playable) parts.push(`<circle cx="${n(x)}" cy="${n(y)}" r="18" stroke="#f5eec5" stroke-width="2" stroke-dasharray="3 4" fill="none" opacity=".94"/>`);
      if(danger)parts.push(`<circle cx="${n(x)}" cy="${n(y)}" r="17" class="token-ring-warning"/>`);
      parts.push(`<g data-token="${i}" data-player="${escapeHTML(p.id)}" ${playable?'role="button" tabindex="0"':''} aria-label="${escapeHTML(p.name)} token ${i+1}"><circle class="board-token ${playable?'playable':''}" cx="${n(x)}" cy="${n(y)}" r="${inBase(t)?9.5:11.4}" fill="${p.color}"/><text class="token-letter" x="${n(x)}" y="${n(y+.5)}">${i+1}</text></g>`);
      if(shield||life) parts.push(`<text class="token-marker" x="${n(x+12)}" y="${n(y-11)}">${shield?'◆':'♥'}</text>`);
      if(danger)parts.push(`<text class="token-marker" x="${n(x+12)}" y="${n(y+15)}" fill="#ffadac">${t.dangerTurns}</text>`);
    }
    $('board').innerHTML=parts.filter(x=>typeof x==='string').join('');
    $('board').classList.toggle('reversed-board',state.reverse.remaining>0);
  }
  function clipboard(text,msg){
    if(navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(()=>notice(msg)).catch(()=>fallbackCopy(text,msg));
    else fallbackCopy(text,msg);
  }
  function fallbackCopy(text,msg){
    const el=document.createElement('textarea'); el.value=text;el.style.position='fixed';el.style.opacity='0';document.body.appendChild(el);el.select();
    try{document.execCommand('copy');notice(msg);}catch{notice('Copy failed. Please select and copy the room code.',true);}el.remove();
  }
  function inviteURL(){const u=new URL(location.href);u.searchParams.set('room',state.code);return u.toString();}
  function joinOrCreate(type){
    const name=$('playerName').value.trim();
    if(!name){notice('Enter your player name first.',true);$('playerName').focus();return;}
    if(name.length>20){notice('Maximum 20 characters.',true);return;}
    localStorage.setItem('ludo-rewired-name',name);
    if(type==='join'){
      const code=$('roomInput').value.toUpperCase().replace(/[^A-Z0-9]/g,'').trim();
      if(code.length!==6){notice('Enter a six-character invitation code.',true);return;}
      send({type:'join',name,code});
    } else send({type:'create',name,interval:90});
  }
  $('createBtn').addEventListener('click',()=>joinOrCreate('create'));
  $('joinBtn').addEventListener('click',()=>joinOrCreate('join'));
  $('roomInput').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
  $('roomInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinOrCreate('join');});
  $('playerName').addEventListener('keydown',e=>{if(e.key==='Enter')joinOrCreate($('roomInput').value.trim()?'join':'create');});
  $('copyCodeBtn').addEventListener('click',()=>clipboard(state.code,'Invite code copied!'));
  $('copyLinkBtn').addEventListener('click',()=>clipboard(inviteURL(),'Invite link copied! Share it with your crew.'));
  $('gameCopyBtn').addEventListener('click',()=>clipboard(inviteURL(),'Invite link copied!'));
  $('startBtn').addEventListener('click',()=>send({type:'start'}));
  $('resetSelect').addEventListener('change',e=>send({type:'settings',interval:Number(e.target.value)}));
  $('actionArea').addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.dataset.mode){selectedMode=button.dataset.mode;renderAction(getMe(),current());renderBoard();return;}
    if(button.dataset.power){
      if(button.dataset.power==='lifeline'&&button.dataset.tokenIndex===undefined){selectingLifeline=true;renderAction(getMe(),current());return;}
      send({type:'power',power:button.dataset.power,tokenIndex:button.dataset.tokenIndex!==undefined?Number(button.dataset.tokenIndex):null});return;
    }
    if(button.dataset.action==='powerBack'){selectingLifeline=false;renderAction(getMe(),current());}
    if(button.dataset.action==='roll')send({type:'roll'});
    if(button.dataset.action==='pass')send({type:'pass'});
    if(button.dataset.action==='rematch')send({type:'rematch'});
  });
  function handleToken(target){
    const tok=target.closest('[data-token]');if(!tok||!state)return;
    if(tok.dataset.player!==state.you||state.turnPlayerId!==state.you||state.phase!=='playing')return;
    const index=Number(tok.dataset.token);
    if(!state.roll?.powerChosen){notice('Roll your dice and choose any doubles power first.');return;}
    if(!state.legal[selectedMode]?.includes(index)){notice('This token cannot move with the selected dice. Try another token or die.',true);return;}
    send({type:'move',tokenIndex:index,mode:selectedMode});
  }
  $('board').addEventListener('click',e=>handleToken(e.target));
  $('board').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){handleToken(e.target);e.preventDefault();}});
  function modal(open){$('rulesModal').classList.toggle('hidden',!open);}
  $('rulesBtn').addEventListener('click',()=>modal(true));
  $('closeModal').addEventListener('click',()=>modal(false));
  $('gotItBtn').addEventListener('click',()=>modal(false));
  $('modalBackdrop').addEventListener('click',()=>modal(false));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')modal(false);});
  $('playerName').value=localStorage.getItem('ludo-rewired-name')||'';
  const codeFromLink=new URLSearchParams(location.search).get('room');
  if(codeFromLink) $('roomInput').value=codeFromLink.toUpperCase();
  netStatus(false); connect(); setInterval(updateClocks,250);
  // Lightweight heartbeat for WebSocket hosts and mobile connections.
  setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type:'ping' }));
  }, 30000);
})();
