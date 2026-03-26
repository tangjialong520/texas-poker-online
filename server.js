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
    // 名字重复时自动加数字后缀
    let finalName = name || '玩家';
    const names = this.players.map(p => p.name);
    if (names.includes(finalName)) {
      let suffix = 2;
      while (names.includes(finalName + suffix)) suffix++;
      finalName = finalName + suffix;
    }
    this.players.push({
      socketId,
      name: finalName,
      chips: this.startChips,
      isAI: false,
      id: socketId,
    });
    return finalName; // 返回最终名字
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
  const AI_EMOJI  = ['🤖','🦊','🐼','🐯','🦁','🐸'];
  const AI_PREFIX = ['机器人A','机器人B','机器人C','机器人D','机器人E','机器人F'];
  const players  = room.players.map(p => ({
    ...p,
    bet:       0,
    holeCards: [],
    folded:    false,
    allIn:     false,
    isHuman:   true,
    isAI:      false,
    eliminated: false,
    potContrib: 0,
  }));

  const usedNames = new Set(players.map(p => p.name));

  // 添加AI，名字不与已有玩家重复
  for (let i = 0; i < room.aiCount; i++) {
    const emoji  = AI_EMOJI[i % AI_EMOJI.length];
    let baseName = AI_PREFIX[i % AI_PREFIX.length];
    let aiName   = `${emoji} ${baseName}`;
    // 若重名则加数字后缀
    if (usedNames.has(aiName)) {
      let suffix = 2;
      while (usedNames.has(`${emoji} ${baseName}${suffix}`)) suffix++;
      aiName = `${emoji} ${baseName}${suffix}`;
    }
    usedNames.add(aiName);
    players.push({
      id:        'ai_' + i,
      socketId:  null,
      name:      aiName,
      chips:     room.startChips,
      bet:       0,
      holeCards: [],
      folded:    false,
      allIn:     false,
      isHuman:   false,
      isAI:      true,
      eliminated: false,
      potContrib: 0,
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
  p.potContrib = (p.potContrib || 0) + actual;
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

  // 重置全员准备状态
  room.readyForNext = new Set();

  G.roundNum++;
  G.deck      = shuffle(makeDeck());
  G.community = [];
  G.pot       = 0;
  G.currentBet = BB;
  G.minRaise   = BB;
  G.acted      = new Set();
  G.lastRaiser = null;
  G.gameOver   = false;
  G.players.forEach(p => { p.bet=0; p.holeCards=[]; p.folded=false; p.allIn=false; p.potContrib=0; });

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
        p.potContrib = (p.potContrib || 0) + actual;
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
      p.potContrib = (p.potContrib || 0) + actual;
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
      p.potContrib = (p.potContrib || 0) + actual;
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
      p.potContrib = (p.potContrib || 0) + amt;
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
    const chipsBefore = {};
    G.players.forEach(p => { chipsBefore[p.id] = p.chips; });
    inHand[0].chips += G.pot;
    G.pot = 0;
    setPhase(G, 'showdown');
    broadcastState(room, 'state_update');
    broadcastMsg(room, `${inHand[0].name} 赢得底池！`, inHand[0].id);
    endHand(room, inHand, null, chipsBefore);
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

// 提前结束游戏，所有人回大厅
function endGameEarly(room) {
  clearTurnTimer(room);
  room.aiTimers.forEach(t => clearTimeout(t));
  room.aiTimers = [];
  room.vote = null;
  room.phase = 'waiting';
  room.G = null;
  // 重置玩家状态（保留筹码）
  room.players.forEach(p => { /* 保持原样 */ });
  io.to(room.id).emit('game_ended_early', {
    players: room.players.map(p => ({ id: p.socketId, name: p.name })),
  });
  console.log(`[提前结束] 房间 ${room.id}`);
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

  // ── 边池计算（Side Pot）──
  // 每个在手玩家按其本局总投入从小到大排序，逐层创建边池
  // allIn玩家只参与自己投入范围内的边池
  const allPlayers = G.players; // 含弃牌玩家（弃牌也投入了筹码）
  
  // 收集每个玩家本局实际投入（bet字段已清零，需要从pot还原）
  // 实际上 bet 在每个下注轮结束后被清零了，所以我们在 G 上维护累计投入
  // 用 G.totalBet 记录，这里直接用 potContrib 字段
  // 获取实际分配：边池分配基于 G.potContribs（本局累计投入）
  const contribs = {}; // playerId -> 本局累计投入
  allPlayers.forEach(p => {
    contribs[p.id] = p.potContrib || 0;
  });

  const totalContrib = Object.values(contribs).reduce((a, b) => a + b, 0);
  // 如果 potContrib 没记录（旧逻辑），回退到简单分配
  if (totalContrib === 0) {
    // 简单分配
    const chipsBeforeSimple = {};
    G.players.forEach(p => { chipsBeforeSimple[p.id] = p.chips; });
    inHand.sort((a,b) => cmpHand(hands[b.id], hands[a.id]));
    const topHand = hands[inHand[0].id];
    const winners = inHand.filter(p => cmpHand(hands[p.id], topHand) === 0);
    const share   = Math.floor(G.pot / winners.length);
    winners.forEach(p => { p.chips += share; });
    const remain  = G.pot - share * winners.length;
    if (remain > 0) winners[0].chips += remain;
    G.pot = 0;

    const showdownData = inHand.map(p => ({
      id: p.id, name: p.name,
      holeCards: p.holeCards,
      handName: hands[p.id] ? hands[p.id].name : '',
      handRank: hands[p.id] ? hands[p.id].rank : 0,
      isWinner: winners.some(w => w.id === p.id),
    }));
    endHand(room, winners, showdownData, chipsBeforeSimple);
    return;
  }

  // ── 标准边池计算 ──
  // 按投入量排序，逐层计算主池和边池
  const activePotPlayers = allPlayers.filter(p => contribs[p.id] > 0);
  const sortedByContrib  = [...activePotPlayers].sort((a,b) => contribs[a.id] - contribs[b.id]);

  const pots = []; // [{amount, eligible: [playerId,...]}]
  let prevLevel = 0;

  for (const p of sortedByContrib) {
    const level = contribs[p.id];
    if (level <= prevLevel) continue;
    const cap = level - prevLevel;
    let potAmount = 0;
    activePotPlayers.forEach(q => {
      const contrib = Math.min(contribs[q.id], level) - Math.min(contribs[q.id], prevLevel);
      potAmount += contrib;
    });
    // eligible：投入达到本层的且未弃牌的玩家
    const eligible = inHand.filter(q => contribs[q.id] >= level).map(q => q.id);
    if (potAmount > 0) {
      pots.push({ amount: potAmount, eligible });
    }
    prevLevel = level;
  }

  // 结算前记录每位玩家筹码
  const chipsBeforeStd = {};
  G.players.forEach(p => { chipsBeforeStd[p.id] = p.chips; });

  // 分配每个边池
  const overallWinners = new Set();
  pots.forEach(pot => {
    const eligPlayers = inHand.filter(p => pot.eligible.includes(p.id));
    if (eligPlayers.length === 0) return;
    eligPlayers.sort((a,b) => cmpHand(hands[b.id], hands[a.id]));
    const topHand = hands[eligPlayers[0].id];
    const potWinners = eligPlayers.filter(p => cmpHand(hands[p.id], topHand) === 0);
    const share = Math.floor(pot.amount / potWinners.length);
    potWinners.forEach(p => { p.chips += share; overallWinners.add(p.id); });
    const remain = pot.amount - share * potWinners.length;
    if (remain > 0) potWinners[0].chips += remain;
  });
  G.pot = 0;

  const winners = inHand.filter(p => overallWinners.has(p.id));
  const showdownData = inHand.map(p => ({
    id: p.id, name: p.name,
    holeCards: p.holeCards,
    handName: hands[p.id] ? hands[p.id].name : '',
    handRank: hands[p.id] ? hands[p.id].rank : 0,
    isWinner: overallWinners.has(p.id),
  }));
  endHand(room, winners, showdownData, chipsBeforeStd);
}

function endHand(room, winners, showdownData, chipsBeforeSettle) {
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

  // 计算每位获胜者赢得的筹码数（结算后 - 结算前）
  const winnerChips = {};
  if (chipsBeforeSettle) {
    winners.forEach(w => {
      const before = chipsBeforeSettle[w.id] || 0;
      const gained = w.chips - before;
      if (gained > 0) winnerChips[w.id] = gained;
    });
  }

  // 重置下一手准备状态
  room.readyForNext = new Set();

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
      winnerChips,
      gameOver:     G.gameOver,
      eliminatedPlayers: eliminatedPlayers.map(p => ({ id: p.id, name: p.name })),
      humanCount:   G.players.filter(p => p.isHuman).length,
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
    const hostPlayer = room.players.find(p => p.socketId === socket.id);
    socket.emit('room_created', {
      roomId,
      startChips: chips,
      actionTimeout: timeout,
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
      myName: hostPlayer ? hostPlayer.name : (name || '玩家'),
    });
    console.log(`[房间创建] ${roomId} 房主:${hostPlayer ? hostPlayer.name : name} 筹码:${chips} 倒计时:${timeout}s`);
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
    const finalName = room.addPlayer(socket.id, name || '玩家');
    if (!finalName) {
      socket.emit('error', { msg: '加入失败' });
      return;
    }
    socket.join(roomId.toUpperCase());
    socket.roomId = roomId.toUpperCase();

    io.to(room.id).emit('player_joined', {
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
      newPlayer: finalName,
    });
    socket.emit('join_success', {
      roomId:  room.id,
      players: room.players.map(p => ({ id:p.socketId, name:p.name })),
      isHost:  room.hostId === socket.id,
      startChips: room.startChips,
      actionTimeout: room.actionTimeout,
      myName: finalName,  // 告知客户端最终使用的名字
    });
    console.log(`[加入] ${finalName} 加入 ${room.id}`);
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

  // 下一手（全员确认）
  socket.on('next_hand', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.G) return;
    if (room.G.phase !== 'showdown') return;
    if (room.G.gameOver) return;

    if (!room.readyForNext) room.readyForNext = new Set();
    room.readyForNext.add(socket.id);

    // 统计真人玩家（已连接）
    const humanPlayers = room.G.players.filter(p => p.isHuman && p.socketId);
    const readyCount   = humanPlayers.filter(p => room.readyForNext.has(p.socketId)).length;
    const totalHumans  = humanPlayers.length;

    if (readyCount >= totalHumans) {
      // 全员准备，开始下一手
      room.readyForNext = new Set();
      room.aiTimers.forEach(t => clearTimeout(t));
      room.aiTimers = [];
      startNewHand(room);
    } else {
      // 通知所有人当前准备进度
      const readyNames = humanPlayers
        .filter(p => room.readyForNext.has(p.socketId))
        .map(p => p.name);
      io.to(room.id).emit('next_hand_ready', {
        readyCount,
        totalHumans,
        readyNames,
      });
    }
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

  // ── 提前结束投票 ──
  // 房主发起投票
  socket.on('vote_end_start', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.G) return;
    if (room.hostId !== socket.id) {
      socket.emit('error', { msg: '只有房主可以发起结束投票' });
      return;
    }
    if (room.vote) {
      socket.emit('error', { msg: '已有进行中的投票' });
      return;
    }
    // 只统计真人玩家
    const humanPlayers = room.G.players.filter(p => p.isHuman);
    if (humanPlayers.length <= 1) {
      // 只有一个真人，直接结束
      endGameEarly(room);
      return;
    }
    room.vote = {
      initiator: socket.id,
      votes: {},     // socketId -> true(同意)/false(反对)
      total: humanPlayers.length,
    };
    // 房主自动同意
    room.vote.votes[socket.id] = true;

    io.to(room.id).emit('vote_end_started', {
      initiatorName: room.G.players.find(p => p.socketId === socket.id)?.name || '房主',
      total: humanPlayers.length,
      agreed: 1,
    });
    console.log(`[投票] 房间 ${room.id} 发起提前结束投票`);
  });

  // 玩家投票
  socket.on('vote_end_reply', ({ agree }) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.vote) return;
    const humanPlayers = room.G ? room.G.players.filter(p => p.isHuman) : [];
    const me = humanPlayers.find(p => p.socketId === socket.id);
    if (!me) return;
    if (room.vote.votes[socket.id] !== undefined) {
      socket.emit('error', { msg: '你已经投过票了' });
      return;
    }

    room.vote.votes[socket.id] = agree;
    const agreedCount  = Object.values(room.vote.votes).filter(v => v).length;
    const rejectedIds  = Object.entries(room.vote.votes).filter(([,v]) => !v).map(([id]) => id);
    const votedCount   = Object.keys(room.vote.votes).length;

    // 有人反对 → 立刻公示并取消投票
    if (!agree) {
      const rejectedNames = rejectedIds.map(id => {
        const p = humanPlayers.find(p => p.socketId === id);
        return p ? p.name : '未知';
      });
      io.to(room.id).emit('vote_end_rejected', { rejectedNames });
      room.vote = null;
      return;
    }

    // 全部同意 → 结束游戏
    if (agreedCount >= room.vote.total) {
      room.vote = null;
      endGameEarly(room);
      return;
    }

    // 还未全票，通知进度
    io.to(room.id).emit('vote_end_progress', {
      agreed: agreedCount,
      total: room.vote.total,
      votedCount,
    });
  });

  // 取消投票（房主）
  socket.on('vote_end_cancel', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.vote) return;
    if (room.hostId !== socket.id) return;
    room.vote = null;
    io.to(room.id).emit('vote_end_cancelled', {});
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
//  管理后台 API
// ════════════════════════════════════════════
const SERVER_START_TIME = Date.now();
let peakOnline = 0; // 历史峰值在线人数

// 统计当前在线总人数
function getTotalOnline() {
  let total = 0;
  rooms.forEach(room => {
    total += room.G.players.filter(p => p.isHuman && p.socketId).length;
  });
  return total;
}

// 更新峰值
function updatePeak() {
  const cur = getTotalOnline();
  if (cur > peakOnline) peakOnline = cur;
}

// 格式化运行时间
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${m}分${sec}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}

// 管理后台密码（简单保护）
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin888';

app.use(express.json());

// 管理后台页面
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'admin.html'));
});

// 获取状态 API
app.get('/api/admin/status', (req, res) => {
  const { pass } = req.query;
  if (pass !== ADMIN_PASS) return res.status(403).json({ error: '密码错误' });

  updatePeak();
  const roomList = [];
  rooms.forEach((room, id) => {
    const G = room.G;
    const humans = G.players.filter(p => p.isHuman && p.socketId);
    roomList.push({
      id,
      shortId: id.slice(0, 6).toUpperCase(),
      playerCount: humans.length,
      totalSeats: G.players.length,
      phase: G.phase,
      roundNum: G.roundNum || 0,
      pot: G.pot || 0,
      players: humans.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        socketId: p.socketId,
      })),
    });
  });

  res.json({
    roomCount: rooms.size,
    totalOnline: getTotalOnline(),
    peakOnline,
    uptime: formatUptime(Date.now() - SERVER_START_TIME),
    uptimeMs: Date.now() - SERVER_START_TIME,
    rooms: roomList,
  });
});

// 踢出玩家 API
app.post('/api/admin/kick', (req, res) => {
  const { pass, socketId, reason } = req.body;
  if (pass !== ADMIN_PASS) return res.status(403).json({ error: '密码错误' });

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return res.status(404).json({ error: '玩家不在线' });

  socket.emit('kicked', { reason: reason || '管理员将你踢出' });
  socket.disconnect(true);
  res.json({ ok: true });
});

// 关闭房间 API
app.post('/api/admin/close-room', (req, res) => {
  const { pass, roomId } = req.body;
  if (pass !== ADMIN_PASS) return res.status(403).json({ error: '密码错误' });

  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: '房间不存在' });

  io.to(roomId).emit('room_closed', { reason: '管理员关闭了房间' });
  // 断开所有房间内的 socket
  room.G.players.filter(p => p.isHuman && p.socketId).forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.disconnect(true);
  });
  rooms.delete(roomId);
  res.json({ ok: true });
});

// ════════════════════════════════════════════
//  启动
// ════════════════════════════════════════════
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🃏 德州扑克服务端已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   管理后台: http://localhost:${PORT}/admin`);
  console.log(`   房间管理: ws://localhost:${PORT}\n`);
});
