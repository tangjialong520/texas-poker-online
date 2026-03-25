/**
 * 德州扑克联机服务端
 * Node.js + Socket.io
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// 静态文件（客户端HTML）
app.use(express.static(path.join(__dirname, 'client')));

// ════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════
const SUITS  = ['spade','heart','diamond','club'];
const SB     = 25;
const BB     = 50;
const DEFAULT_START_CHIPS = 1000;

// ════════════════════════════════════════════
//  牌工具
// ════════════════════════════════════════════
function makeDeck() {
  const d = [];
  for (const s of SUITS)
    for (let r = 2; r <= 14; r++)
      d.push({ suit: s, rank: r });
  return d;
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ════════════════════════════════════════════
//  牌型判断
// ════════════════════════════════════════════
function combos(arr, k) {
  if (k === 0) return [[]];
  if (!arr.length) return [];
  const [f, ...r] = arr;
  return [...combos(r, k-1).map(c => [f,...c]), ...combos(r, k)];
}

function evalFive(cs) {
  const ranks = cs.map(c => c.rank).sort((a,b) => b-a);
  const suits = cs.map(c => c.suit);
  const isF   = new Set(suits).size === 1;
  const isN   = ranks.every((r,i) => i===0 || ranks[i-1]-r===1);
  const isW   = ranks.join(',') === '14,5,4,3,2';
  const isS   = isN || isW;
  const sHi   = isW ? 5 : ranks[0];
  const cnt   = {};
  ranks.forEach(r => cnt[r] = (cnt[r]||0)+1);
  const vals  = Object.values(cnt).sort((a,b) => b-a);
  const byC   = n => Object.keys(cnt).filter(k => cnt[k]===n).map(Number).sort((a,b) => b-a);
  if (isF&&isS) return sHi===14
    ? { rank:10, name:'皇家同花顺', tb:[14] }
    : { rank:9,  name:'同花顺',    tb:[sHi] };
  if (vals[0]===4) { const f=byC(4)[0],k=byC(1)[0]; return{ rank:8, name:'四条',  tb:[f,k]       }; }
  if (vals[0]===3&&vals[1]===2){ const t=byC(3)[0],p=byC(2)[0]; return{ rank:7, name:'葫芦', tb:[t,p] }; }
  if (isF) return { rank:6, name:'同花',  tb:ranks };
  if (isS) return { rank:5, name:'顺子',  tb:[sHi] };
  if (vals[0]===3){ const t=byC(3)[0],ks=byC(1); return{ rank:4, name:'三条', tb:[t,...ks] }; }
  if (vals[0]===2&&vals[1]===2){ const ps=byC(2),k=byC(1)[0]; return{ rank:3, name:'两对', tb:[...ps,k] }; }
  if (vals[0]===2){ const p=byC(2)[0],ks=byC(1); return{ rank:2, name:'一对', tb:[p,...ks] }; }
  return { rank:1, name:'高牌', tb:ranks };
}

function evalHand(cs) {
  if (cs.length < 5) return evalFive(cs);
  let best = null;
  for (const five of combos(cs, 5)) {
    const r = evalFive(five);
    if (!best || cmpHand(r, best) > 0) best = r;
  }
  return best;
}

function cmpHand(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tb.length, b.tb.length); i++) {
    const d = (a.tb[i]||0) - (b.tb[i]||0);
    if (d !== 0) return d;
  }
  return 0;
}

// ════════════════════════════════════════════
//  AI决策（服务端内置）
// ════════════════════════════════════════════
function preFlopRank(hc) {
  const [a,b] = hc; if(!a||!b) return 1;
  const isPair = a.rank===b.rank, isSuited = a.suit===b.suit;
  const sum=a.rank+b.rank, diff=Math.abs(a.rank-b.rank);
  if(isPair&&a.rank>=10) return 3;
  if(isPair) return 2;
  if(sum>=26&&isSuited) return 6;
  if(sum>=24) return 2;
  if(isSuited&&diff<=2) return 2;
  return 1;
}

function equity(rank) {
  const t = {1:.15,2:.35,3:.55,4:.70,5:.80,6:.85,7:.92,8:.97,9:.99,10:1.0};
  return t[rank] || .2;
}

function computeAI(p, G) {
  const callAmt = Math.max(0, G.currentBet - p.bet);
  const all     = [...p.holeCards, ...G.community];
  let rank = all.length>=5 ? (evalHand(all)||{rank:1}).rank : preFlopRank(p.holeCards);
  const eq  = equity(rank);
  const po  = callAmt>0 ? callAmt/(G.pot+callAmt) : 0;
  const blf = 0.1;

  if (rank>=7) {
    if (callAmt===0 && Math.random()<.45) return { type:'check' };
    const r = G.currentBet + Math.max(G.minRaise, Math.round(G.pot*.65/25)*25);
    if (r <= p.chips+p.bet) return { type:'raise', amount:r };
    return { type:'allin' };
  }
  if (eq>0.65) {
    if (callAmt===0) {
      if (Math.random()<.35) {
        const r = G.currentBet + Math.max(G.minRaise, BB*2);
        return { type:'raise', amount:Math.min(r, p.chips+p.bet) };
      }
      return { type:'check' };
    }
    return { type:'call' };
  }
  if (eq > po+.05) {
    if (callAmt===0) return { type:'check' };
    return { type:'call' };
  }
  if (Math.random()<blf && callAmt===0) {
    const r = G.currentBet + Math.max(G.minRaise, Math.round(G.pot*.75/25)*25);
    return { type:'raise', amount:Math.min(r, p.chips+p.bet) };
  }
  if (callAmt===0) return { type:'check' };
  if (callAmt<=BB && Math.random()<.45) return { type:'call' };
  return { type:'fold' };
}

// ════════════════════════════════════════════
//  房间管理
// ════════════════════════════════════════════
const rooms = new Map(); // roomId -> Room

class Room {
  constructor(id, hostSocketId, hostName, aiCount, startChips, actionTimeout) {
    this.id           = id;
    this.hostId       = hostSocketId;
    this.aiCount      = aiCount || 0;
    this.phase        = 'waiting';  // waiting | playing
    this.players      = [];
    this.maxPlayers   = 6;
    this.G            = null;
    this.aiTimers     = [];
    this.startChips   = startChips || DEFAULT_START_CHIPS;
    this.actionTimeout = actionTimeout || 0; // 0=无限制，单位秒
    this.turnTimer    = null; // 当前行动倒计时

    // 加入房主
    this.addPlayer(hostSocketId, hostName);
  }

  addPlayer(socketId, name) {
    if (this.players.length >= this.maxPlayers) return false;
    if (this.players.find(p => p.socketId === socketId)) return false;
    this.players.push({
      socketId,
      name,
      chips: this.startChips,
      isAI: false,
      id: socketId,
    });
    return true;
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    if (this.players.length === 0) {
      rooms.delete(this.id);
    } else if (this.hostId === socketId) {
      this.hostId = this.players[0].socketId;
    }
  }

  // 生成客户端可见的房间状态（不含底牌）
  publicState() {
    const G = this.G;
    if (!G) return null;
    return {
      phase:        G.phase,
      pot:          G.pot,
      community:    G.community,
      currentBet:   G.currentBet,
      minRaise:     G.minRaise,
      dealerIdx:    G.dealerIdx,
      actIdx:       G.actIdx,
      roundNum:     G.roundNum,
      actionTimeout: this.actionTimeout,
      gameOver:     G.gameOver || false,
      players: G.players.map(p => ({
        id:        p.id,
        name:      p.name,
        chips:     p.chips,
        bet:       p.bet,
        folded:    p.folded,
        allIn:     p.allIn,
        isAI:      p.isAI,
        isHuman:   p.isHuman,
        cardCount: p.holeCards.length,
        eliminated: p.eliminated || false,
      })),
    };
  }
}

// ════════════════════════════════════════════
//  游戏逻辑（服务端）
// ════════════════════════════════════════════
function startGame(room) {
  const AI_NAMES = ['🤖 机器人A','🦊 机器人B','🐼 机器人C','🐯 机器人D'];
  const players  = room.players.map(p => ({
    ...p,
    bet:       0,
    holeCards: [],
    folded:    false,
    allIn:     false,
    isHuman:   true,
    isAI:      false,
    eliminated: false,
  }));

  // 添加AI
  for (let i = 0; i < room.aiCount; i++) {
    players.push({
      id:        'ai_' + i,
      socketId:  null,
      name:      AI_NAMES[i],
      chips:     room.startChips,
      bet:       0,
      holeCards: [],
      folded:    false,
      allIn:     false,
      isHuman:   false,
      isAI:      true,
      eliminated: false,
    });
  }

  room.G = {
    players,
    deck:        [],
    community:   [],
    pot:         0,
    phase:       'preflop',
    currentBet:  BB,
    minRaise:    BB,
    dealerIdx:   0,
    actIdx:      0,
    roundNum:    0,
    acted:       new Set(),
    lastRaiser:  null,
    gameOver:    false,
  };

  room.phase = 'playing';
  startNewHand(room);
}

function nextActiveIdx(G, from) {
  const n = G.players.length;
  let idx = (from + 1) % n;
  let tries = 0;
  while ((G.players[idx].folded || G.players[idx].chips === 0) && tries < n) {
    idx = (idx + 1) % n;
    tries++;
  }
  return idx;
}

function collectBlind(G, idx, amount) {
  const p = G.players[idx];
  const actual = Math.min(amount, p.chips);
  p.chips -= actual;
  p.bet   += actual;
  G.pot   += actual;
}

function activePlayers(G) {
  return G.players.filter(p => !p.folded && p.chips + p.bet > 0);
}

function inHandPlayers(G) {
  return G.players.filter(p => !p.folded);
}

function startNewHand(room) {
  const G = room.G;

  // 清除倒计时
  clearTurnTimer(room);

  G.roundNum++;
  G.deck      = shuffle(makeDeck());
  G.community = [];
  G.pot       = 0;
  G.currentBet = BB;
  G.minRaise   = BB;
  G.acted      = new Set();
  G.lastRaiser = null;
  G.gameOver   = false;
  G.players.forEach(p => { p.bet=0; p.holeCards=[]; p.folded=false; p.allIn=false; });

  // 移动庄家（跳过已淘汰/无筹码的）
  G.dealerIdx = nextActiveIdx(G, G.dealerIdx);

  // 发牌（只发给有筹码的玩家）
  G.players.filter(p => p.chips > 0).forEach(p => {
    p.holeCards.push(G.deck.pop(), G.deck.pop());
  });

  // 收盲注
  const sbIdx = nextActiveIdx(G, G.dealerIdx);
  const bbIdx = nextActiveIdx(G, sbIdx);
  collectBlind(G, sbIdx, SB);
  collectBlind(G, bbIdx, BB);
  G.currentBet = BB;
  G.lastRaiser = G.players[bbIdx].id;

  setPhase(G, 'preflop');

  // 广播游戏开始
  broadcastState(room, 'hand_started');

  // Pre-Flop从BB左边开始
  const firstAct = nextActiveIdx(G, bbIdx);
  G.actIdx = firstAct;
  broadcastState(room, 'turn_start');
  scheduleAction(room);
}

function setPhase(G, phase) {
  G.phase = phase;
}

// 广播公共状态 + 分别发各自底牌
function broadcastState(room, event) {
  const G    = room.G;
  const pub  = room.publicState();

  G.players.filter(p => p.isHuman).forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (!socket) return;
    socket.emit(event, {
      ...pub,
      myCards: p.holeCards,
      myId:    p.id,
    });
  });
}

// 通知轮到谁了
function notifyTurn(room) {
  const G   = room.G;
  const cur = G.players[G.actIdx];
  broadcastState(room, 'state_update');

  if (cur.isHuman) {
    const socket = io.sockets.sockets.get(cur.socketId);
    if (socket) {
      socket.emit('your_turn', {
        callAmount:    Math.max(0, G.currentBet - cur.bet),
        minRaise:      G.currentBet + G.minRaise,
        maxRaise:      cur.chips + cur.bet,
        currentBet:    G.currentBet,
        pot:           G.pot,
        actionTimeout: room.actionTimeout,
      });
    }
  }
}

// ── 倒计时管理 ──
function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function startTurnTimer(room) {
  if (!room.actionTimeout || room.actionTimeout <= 0) return;
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => {
    const G = room.G;
    if (!G || G.phase === 'showdown') return;
    const cur = G.players[G.actIdx];
    if (!cur || cur.isAI) return;
    // 超时自动弃牌
    broadcastMsg(room, `⏰ ${cur.name} 超时，自动弃牌`, cur.id);
    applyAction(room, cur.id, 'fold');
  }, room.actionTimeout * 1000);
}

function scheduleAction(room) {
  const G   = room.G;
  const cur = G.players[G.actIdx];

  clearTurnTimer(room);

  if (cur.isAI) {
    const delay = 700 + Math.random() * 1500;
    const timer = setTimeout(() => {
      const { type, amount } = computeAI(cur, G);
      applyAction(room, cur.id, type, amount);
    }, delay);
    room.aiTimers.push(timer);
  } else {
    notifyTurn(room);
    startTurnTimer(room);
  }
}

function applyAction(room, playerId, type, raiseTarget) {
  const G = room.G;
  const p = G.players.find(pl => pl.id === playerId);
  if (!p) return;

  clearTurnTimer(room);

  const callAmt = Math.max(0, G.currentBet - p.bet);
  let msg = '';

  switch (type) {
    case 'fold':
      p.folded = true;
      msg = `${p.name} 弃牌`;
      break;

    case 'check':
      if (callAmt > 0) {
        const actual = Math.min(callAmt, p.chips);
        p.chips -= actual; p.bet += actual; G.pot += actual;
        if (p.chips === 0) p.allIn = true;
        G.acted.add(p.id);
        msg = `${p.name} 跟注 ${actual}`;
        break;
      }
      G.acted.add(p.id);
      msg = `${p.name} 过牌`;
      break;

    case 'call': {
      const actual = Math.min(callAmt, p.chips);
      p.chips -= actual; p.bet += actual; G.pot += actual;
      if (p.chips === 0) p.allIn = true;
      G.acted.add(p.id);
      msg = `${p.name} 跟注 ${actual}`;
      break;
    }

    case 'raise': {
      const target = raiseTarget || (G.currentBet + G.minRaise);
      const toAdd  = target - p.bet;
      const actual = Math.min(toAdd, p.chips);
      p.chips -= actual; p.bet += actual; G.pot += actual;
      G.minRaise   = p.bet - G.currentBet;
      G.currentBet = p.bet;
      G.lastRaiser = p.id;
      G.acted      = new Set([p.id]);
      if (p.chips === 0) p.allIn = true;
      msg = `${p.name} 加注到 ${p.bet}`;
      break;
    }

    case 'allin': {
      const amt = p.chips;
      p.chips -= amt; p.bet += amt; G.pot += amt;
      if (p.bet > G.currentBet) {
        G.minRaise   = p.bet - G.currentBet;
        G.currentBet = p.bet;
        G.lastRaiser = p.id;
        G.acted      = new Set([p.id]);
      } else {
        G.acted.add(p.id);
      }
      p.allIn = true;
      msg = `${p.name} 全押！`;
      break;
    }

    default:
      return;
  }

  broadcastMsg(room, msg, playerId);
  broadcastState(room, 'state_update');
  setTimeout(() => advanceTurn(room), 400);
}

function broadcastMsg(room, text, actorId) {
  const G = room.G;
  G.players.filter(p => p.isHuman).forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('game_msg', { text, actorId });
  });
}

function advanceTurn(room) {
  const G      = room.G;
  const inHand = inHandPlayers(G);

  // 只剩一人
  if (inHand.length === 1) {
    inHand[0].chips += G.pot;
    G.pot = 0;
    setPhase(G, 'showdown');
    broadcastState(room, 'state_update');
    broadcastMsg(room, `${inHand[0].name} 赢得底池！`, inHand[0].id);
    endHand(room, inHand);
    return;
  }

  // 判断本轮是否结束
  const needAct  = inHand.filter(p => !p.allIn);
  const roundDone = needAct.every(p => p.bet === G.currentBet && G.acted.has(p.id));

  if (roundDone) {
    advancePhase(room);
    return;
  }

  // 找下一个需要行动的玩家
  let next  = (G.actIdx + 1) % G.players.length;
  let tries = 0;
  while (tries < G.players.length) {
    const pl = G.players[next];
    if (!pl.folded && !pl.allIn && pl.chips > 0) {
      if (G.acted.has(pl.id) && pl.bet === G.currentBet && pl.id !== G.lastRaiser) {
        next = (next + 1) % G.players.length;
        tries++;
        continue;
      }
      break;
    }
    next = (next + 1) % G.players.length;
    tries++;
  }

  if (tries >= G.players.length) {
    advancePhase(room);
    return;
  }

  G.actIdx = next;
  scheduleAction(room);
}

function advancePhase(room) {
  const G = room.G;
  G.players.forEach(p => p.bet = 0);
  G.currentBet = 0;
  G.minRaise   = BB;
  G.acted      = new Set();
  G.lastRaiser = null;

  const order = ['preflop','flop','turn','river','showdown'];
  const idx   = order.indexOf(G.phase);
  if (idx < 0 || idx >= order.length - 1) { doShowdown(room); return; }
  setPhase(G, order[idx+1]);

  if (G.phase === 'flop') {
    G.community.push(G.deck.pop(), G.deck.pop(), G.deck.pop());
    broadcastMsg(room, '🂠🂠🂠 翻牌！', null);
  } else if (G.phase === 'turn') {
    G.community.push(G.deck.pop());
    broadcastMsg(room, '🂠 转牌！', null);
  } else if (G.phase === 'river') {
    G.community.push(G.deck.pop());
    broadcastMsg(room, '🂠 河牌！', null);
  } else if (G.phase === 'showdown') {
    doShowdown(room);
    return;
  }

  broadcastState(room, 'state_update');

  const nextIdx = nextActiveIdx(G, G.dealerIdx);
  G.actIdx = nextIdx;
  scheduleAction(room);
}

function doShowdown(room) {
  const G      = room.G;
  const inHand = inHandPlayers(G);

  setPhase(G, 'showdown');

  const hands = {};
  inHand.forEach(p => {
    const all = [...p.holeCards, ...G.community];
    hands[p.id] = all.length >= 5 ? evalHand(all) : evalFive(p.holeCards);
  });

  inHand.sort((a,b) => cmpHand(hands[b.id], hands[a.id]));
  const topHand = hands[inHand[0].id];
  const winners = inHand.filter(p => cmpHand(hands[p.id], topHand) === 0);
  const share   = Math.floor(G.pot / winners.length);
  winners.forEach(p => { p.chips += share; });
  const remain  = G.pot - share * winners.length;
  if (remain > 0) winners[0].chips += remain;
  G.pot = 0;

  // 构建摊牌数据（只揭示在手的人的底牌，折叠玩家不揭示）
  const showdownData = inHand.map(p => ({
    id:        p.id,
    name:      p.name,
    holeCards: p.holeCards,
    handName:  hands[p.id] ? hands[p.id].name : '',
    handRank:  hands[p.id] ? hands[p.id].rank : 0,
    isWinner:  winners.some(w => w.id === p.id),
  }));

  endHand(room, winners, showdownData);
}

function endHand(room, winners, showdownData) {
  const G   = room.G;
  setPhase(G, 'showdown');

  // 检查是否有人筹码归零（游戏结束条件）
  const eliminatedPlayers = G.players.filter(p => p.chips <= 0 && !p.eliminated);
  eliminatedPlayers.forEach(p => p.eliminated = true);

  // 检查游戏是否结束：只剩1个有筹码的玩家（或者有真人玩家筹码归零）
  const activePls = G.players.filter(p => p.chips > 0);
  const humanEliminated = eliminatedPlayers.filter(p => p.isHuman);

  // 游戏结束：只剩一个有筹码的人，或有人筹码清零
  const gameIsOver = activePls.length <= 1 || humanEliminated.length > 0 ||
    G.players.filter(p => p.isHuman && p.chips <= 0).length > 0;

  if (gameIsOver) {
    G.gameOver = true;
  }

  const pub = room.publicState();
  G.players.filter(p => p.isHuman).forEach(p => {
    const socket = io.sockets.sockets.get(p.socketId);
    if (!socket) return;
    socket.emit('hand_over', {
      ...pub,
      myCards:      p.holeCards,
      myId:         p.id,
      showdownData: showdownData || null,
      winnerIds:    winners.map(w => w.id),
      gameOver:     G.gameOver,
      eliminatedPlayers: eliminatedPlayers.map(p => ({ id: p.id, name: p.name })),
    });
  });
}

// ════════════════════════════════════════════
//  Socket.io 事件处理
// ════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 创建房间
  socket.on('create_room', ({ name, aiCount, startChips, actionTimeout }) => {
    const roomId = Math.random().toString(36).substr(2,6).toUpperCase();
    const chips  = Math.max(100, Math.min(100000, parseInt(startChips) || DEFAULT_START_CHIPS));
    const timeout = parseInt(actionTimeout) || 0;
    const room   = new Room(roomId, socket.id, name || '玩家', aiCount || 0, chips, timeout);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', {
      roomId,
      startChips: chips,
      actionTimeout: timeout,
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
    });
    console.log(`[房间创建] ${roomId} 房主:${name} 筹码:${chips} 倒计时:${timeout}s`);
  });

  // 加入房间
  socket.on('join_room', ({ roomId, name }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) {
      socket.emit('error', { msg: '房间不存在' });
      return;
    }
    if (room.phase === 'playing') {
      socket.emit('error', { msg: '游戏已开始，无法加入' });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit('error', { msg: '房间已满' });
      return;
    }
    const ok = room.addPlayer(socket.id, name || '玩家');
    if (!ok) {
      socket.emit('error', { msg: '加入失败' });
      return;
    }
    socket.join(roomId.toUpperCase());
    socket.roomId = roomId.toUpperCase();

    io.to(room.id).emit('player_joined', {
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
      newPlayer: name,
    });
    socket.emit('join_success', {
      roomId:  room.id,
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
      isHost:  room.hostId === socket.id,
      startChips: room.startChips,
      actionTimeout: room.actionTimeout,
    });
    console.log(`[加入] ${name} 加入 ${room.id}`);
  });

  // 房主开始游戏
  socket.on('start_game', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('error', { msg: '只有房主可以开始游戏' });
      return;
    }
    startGame(room);
    console.log(`[游戏开始] 房间 ${room.id}`);
  });

  // 玩家行动
  socket.on('player_action', ({ type, amount }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.G) return;

    const G   = room.G;
    const cur = G.players[G.actIdx];
    if (cur.socketId !== socket.id) {
      socket.emit('error', { msg: '还没轮到你' });
      return;
    }
    applyAction(room, cur.id, type, amount);
  });

  // 下一手
  socket.on('next_hand', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.G) return;
    if (room.G.phase !== 'showdown') return;
    if (room.G.gameOver) return; // 游戏结束时不允许直接下一手
    room.aiTimers.forEach(t => clearTimeout(t));
    room.aiTimers = [];
    startNewHand(room);
  });

  // 游戏结束后继续（重置筹码）
  socket.on('continue_game', ({ startChips }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.G) return;
    if (!room.G.gameOver) return;

    const chips = Math.max(100, Math.min(100000, parseInt(startChips) || room.startChips));
    room.startChips = chips;

    // 重置所有玩家筹码（包括AI）
    room.G.players.forEach(p => {
      p.chips = chips;
      p.eliminated = false;
    });
    room.G.gameOver = false;

    room.aiTimers.forEach(t => clearTimeout(t));
    room.aiTimers = [];
    startNewHand(room);

    // 通知继续
    io.to(room.id).emit('game_continued', { startChips: chips });
  });

  // 游戏结束后解散
  socket.on('dissolve_room', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('error', { msg: '只有房主可以解散房间' });
      return;
    }
    clearTurnTimer(room);
    room.aiTimers.forEach(t => clearTimeout(t));
    io.to(room.id).emit('room_dissolved', {});
    rooms.delete(room.id);
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);
    const room = rooms.get(socket.roomId);
    if (!room) return;

    const playerName = room.players.find(p => p.socketId === socket.id)?.name || '玩家';
    room.removePlayer(socket.id);

    if (rooms.has(socket.roomId)) {
      io.to(socket.roomId).emit('player_left', {
        players:    room.players.map(p => ({ id:p.socketId, name:p.name })),
        leftPlayer: playerName,
      });
    }
  });

  // 获取房间列表
  socket.on('list_rooms', () => {
    const list = [];
    rooms.forEach((room, id) => {
      list.push({
        id,
        playerCount: room.players.length,
        phase:       room.phase,
      });
    });
    socket.emit('room_list', list);
  });
});

// ════════════════════════════════════════════
//  启动
// ════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🃏 德州扑克服务端已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   房间管理: ws://localhost:${PORT}\n`);
});
