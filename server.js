'use strict';

/**
 * 双人俄罗斯方块后端（Node.js >= 20）。运行：npm install && npm start
 * 前端由 Express 的 public/ 目录提供，Socket.io 客户端可从
 * /socket.io/socket.io.js 加载；不使用任何国外云服务或 CDN。
 *
 * 同步方式：客户端预测操作；服务端独立模拟并广播有序操作结果。
 * 客户端绝不能自己决定棋盘、消行数、攻击数、得分或胜负。
 * 首次开始、重连、主动纠偏时发完整快照，正常游戏只发增量事件。
 *
 * 本版规则：10 列、20 可见行 + 顶部 2 隐藏行、七袋随机、相同出块序列；
 * 消 N 行产生 N 点攻击，先移除自己已有的最底部垃圾行，再抵消待入场
 * 垃圾行，剩余攻击发给对手。垃圾行在接收者下次锁定结算后入场。
 * 旋转使用简单踢墙规则；本版暂不包含完整 SRS、Hold 和锁定延迟。
 */
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomInt, randomUUID, timingSafeEqual } = require('node:crypto');
const { Server } = require('socket.io');

const WIDTH = 10;
const HEIGHT = 22;
const HIDDEN_ROWS = 2;
const FALL_MS = 800;
const RECONNECT_MS = 30_000;
const WAIT_TTL_MS = 10 * 60_000;
const FINISHED_TTL_MS = 5 * 60_000;
const MAX_ROOMS = 1000;
const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
// 0 是空格，1～7 是普通方块，8 是垃圾块。颜色留给前端决定。
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};
const ACTIONS = new Set(['left', 'right', 'rotateCW', 'rotateCCW', 'softDrop', 'hardDrop']);
const emptyRow = () => Array(WIDTH).fill(0);

// 将活动方块换算成棋盘坐标；客户端可以使用完全相同的算法。
function cells(piece) {
  let shape = SHAPES[piece.type];
  for (let r = 0; r < piece.rotation; r++) {
    shape = shape[0].map((_, x) => shape.map(row => row[x]).reverse());
  }
  return shape.flatMap((row, y) => row.flatMap((value, x) =>
    value ? [{ x: piece.x + x, y: piece.y + y }] : []));
}

function fits(player, piece) {
  return cells(piece).every(({ x, y }) =>
    x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && player.board[y][x] === 0);
}

function removeRows(player, indices) {
  const remove = new Set(indices);
  player.board = player.board.filter((_, y) => !remove.has(y));
  player.garbageRows = player.garbageRows.filter((_, y) => !remove.has(y));
  while (player.board.length < HEIGHT) {
    player.board.unshift(emptyRow());
    player.garbageRows.unshift(false);
  }
}

// 每行独立生成 1～2 个不同的空洞，具体位置由服务端广播，客户端不能自行随机。
function makeGarbage() {
  const holes = new Set();
  const count = randomInt(1, 3);
  while (holes.size < count) holes.add(randomInt(WIDTH));
  return { holes: [...holes].sort((a, b) => a - b) };
}

function tokenMatches(actual, provided) {
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(provided, 'hex'));
}

function makePlayer(socketId) {
  return {
    id: randomUUID(), resumeToken: randomBytes(32).toString('hex'),
    socketId, connected: true, disconnectedAt: null,
    board: Array.from({ length: HEIGHT }, emptyRow),
    garbageRows: Array(HEIGHT).fill(false), pendingGarbage: [],
    activePiece: null, pieceIndex: 0, score: 0, lines: 0,
    lastInputSeq: 0, fallElapsed: 0, gameOver: false,
  };
}

function createGameServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  // 同源部署无需 CORS；如需前后端分离，配置精确的 FRONTEND_ORIGIN。
  const frontendOrigin = process.env.FRONTEND_ORIGIN;
  const io = new Server(server, {
    pingInterval: 5000,        // Socket.io 内置 ping/pong 心跳，不需要重复实现。
    pingTimeout: 5000,         // 未回应心跳即触发 disconnect。
    maxHttpBufferSize: 4096,   // 限制单条客户端消息大小。
    ...(frontendOrigin ? { cors: { origin: frontendOrigin } } : {}),
    // 直接 WebSocket 请求同样检查 Origin；无 Origin 的非浏览器客户端允许接入。
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      let allowed = !origin;
      try {
        if (origin) allowed = frontendOrigin
          ? origin === frontendOrigin
          : new URL(origin).host === req.headers.host;
      } catch { allowed = false; }
      callback(null, allowed);
    },
  });
  const rooms = new Map();
  const reconnectMs = options.reconnectMs ?? RECONNECT_MS;
  const channel = room => `room:${room.id}`;
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_req, res) => res.json({ ok: true }));

  function roomState(room) {
    return {
      roomId: room.id, matchId: room.matchId, status: room.status,
      serverTime: Date.now(), elapsedMs: room.elapsedMs || 0,
      rematchReady: room.rematchReady || [],
      winnerId: room.winnerId, reason: room.reason,
      players: room.players.map(p => ({
        playerId: p.id, connected: p.connected,
        reconnectDeadline: p.disconnectedAt === null ? null : p.disconnectedAt + reconnectMs,
      })),
      message: room.status === 'paused' ? '对手掉线，等待重连' : '',
    };
  }

  // 白名单序列化：不得把 resumeToken、socketId 等私有字段发给对手。
  function snapshot(room, self) {
    return {
      ...roomState(room), selfId: self.id, eventSeq: room.eventSeq,
      serverTime: Date.now(), width: WIDTH, height: HEIGHT, hiddenRows: HIDDEN_ROWS,
      fallMs: FALL_MS,
      players: room.players.map(p => ({
        playerId: p.id, connected: p.connected, board: p.board,
        reconnectDeadline: p.disconnectedAt === null ? null : p.disconnectedAt + reconnectMs,
        garbageRows: p.garbageRows, pendingGarbage: p.pendingGarbage,
        activePiece: p.activePiece, nextQueue: preview(room, p),
        score: p.score, lines: p.lines, lastInputSeq: p.lastInputSeq,
        fallElapsed: p.fallElapsed, gameOver: p.gameOver,
      })),
    };
  }

  function publishRoom(room) { io.to(channel(room)).emit('room:state', roomState(room)); }
  function sendSnapshots(room, event) {
    for (const p of room.players) {
      if (p.connected) io.to(p.socketId).emit(event, snapshot(room, p));
    }
  }
  function publishEvent(room, player, action, inputSeq, operations) {
    io.to(channel(room)).emit('game:event', {
      roomId: room.id, matchId: room.matchId, eventSeq: ++room.eventSeq,
      playerId: player.id, action, inputSeq, operations, serverTime: Date.now(),
    });
  }

  // 房间只保留双方仍需要的方块序列；慢的一方追上后丢弃前面的历史。
  function ensureQueue(room, end) {
    while (room.sequenceBase + room.sequence.length < end) {
      const bag = [...TYPES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      room.sequence.push(...bag);
    }
  }
  function preview(room, p) {
    ensureQueue(room, p.pieceIndex + 5);
    return room.sequence.slice(p.pieceIndex - room.sequenceBase, p.pieceIndex - room.sequenceBase + 5);
  }
  function spawn(room, p, operations) {
    ensureQueue(room, p.pieceIndex + 1);
    const type = room.sequence[p.pieceIndex++ - room.sequenceBase];
    p.activePiece = { type, rotation: 0, x: Math.floor((WIDTH - SHAPES[type].length) / 2), y: 0 };
    p.fallElapsed = 0;
    const nextQueue = preview(room, p);
    if (!fits(p, p.activePiece)) p.gameOver = true;
    operations.push({ type: 'spawn', playerId: p.id, activePiece: { ...p.activePiece }, nextQueue });
    const consumed = Math.min(...room.players.map(player => player.pieceIndex));
    room.sequence.splice(0, consumed - room.sequenceBase);
    room.sequenceBase = consumed;
  }

  function finish(room, winnerId, reason) {
    if (room.status === 'finished') return;
    room.status = 'finished';
    room.winnerId = winnerId;
    room.reason = reason;
    room.finishedAt = Date.now();
    publishRoom(room);
    sendSnapshots(room, 'game:over');
  }

  function lockPiece(room, p, operations) {
    const lockedCells = cells(p.activePiece);
    const value = TYPES.indexOf(p.activePiece.type) + 1;
    for (const { x, y } of lockedCells) p.board[y][x] = value;
    p.activePiece = null;
    operations.push({ type: 'lock', playerId: p.id, cells: lockedCells, value });

    // 消行只能从服务端棋盘计算；客户端上报 clear/lines 一律不作为依据。
    const cleared = [];
    p.board.forEach((row, y) => { if (row.every(Boolean)) cleared.push(y); });
    if (cleared.length) {
      removeRows(p, cleared);
      p.lines += cleared.length;
      p.score += [0, 100, 300, 500, 800][cleared.length] ?? cleared.length * 200;
      operations.push({ type: 'clear', playerId: p.id, rows: cleared, score: p.score, lines: p.lines });
    }

    // 按本项目约定，攻击额度先清除自己已入场的垃圾行（从最下面开始）。
    // garbageRows 标记跟随行移动，不能通过颜色猜测，否则填洞后会识别错误。
    let attack = cleared.length;
    const removed = [];
    for (let y = HEIGHT - 1; y >= 0 && attack > 0; y--) {
      if (p.garbageRows[y]) { removed.push(y); attack--; }
    }
    if (removed.length) {
      removeRows(p, removed);
      operations.push({ type: 'garbage:remove', playerId: p.id, rows: removed });
    }
    const cancelled = Math.min(attack, p.pendingGarbage.length);
    if (cancelled) {
      p.pendingGarbage.splice(0, cancelled);
      attack -= cancelled;
      operations.push({ type: 'garbage:cancel', playerId: p.id, count: cancelled });
    }

    const opponent = room.players.find(other => other.id !== p.id);
    if (attack && opponent) {
      const rows = Array.from({ length: attack }, makeGarbage);
      opponent.pendingGarbage.push(...rows);
      operations.push({ type: 'garbage:queue', playerId: opponent.id, rows });
    }

    // 消行及抵消完成后，剩余待入场垃圾行从底部抬升，绝不悄悄吞掉顶部方块。
    const incoming = p.pendingGarbage.splice(0);
    if (incoming.length) {
      for (const { holes } of incoming) {
        if (p.board[0].some(Boolean)) p.gameOver = true;
        p.board.shift();
        p.garbageRows.shift();
        p.board.push(Array.from({ length: WIDTH }, (_, x) => holes.includes(x) ? 0 : 8));
        p.garbageRows.push(true);
      }
      operations.push({ type: 'garbage:insert', playerId: p.id, rows: incoming });
    }
    if (p.board.slice(0, HIDDEN_ROWS).some(row => row.some(Boolean))) p.gameOver = true;
    if (!p.gameOver) spawn(room, p, operations);
  }

  function simulate(room, p, action, inputSeq = null) {
    const operations = [];
    const current = p.activePiece;
    let next = { ...current };
    if (action === 'left' || action === 'right') {
      next.x += action === 'left' ? -1 : 1;
      if (fits(p, next)) p.activePiece = next;
    } else if (action === 'rotateCW' || action === 'rotateCCW') {
      next.rotation = (next.rotation + (action === 'rotateCW' ? 1 : 3)) % 4;
      // 简单水平踢墙：依次尝试原位、左右一格、左右两格。
      for (const dx of [0, -1, 1, -2, 2]) {
        const candidate = { ...next, x: next.x + dx };
        if (fits(p, candidate)) { p.activePiece = candidate; break; }
      }
    } else if (action === 'hardDrop') {
      while (fits(p, { ...next, y: next.y + 1 })) next.y++;
      p.activePiece = next;
      lockPiece(room, p, operations);
    } else { // softDrop 或服务端 gravity：向下失败即锁定。
      next.y++;
      if (fits(p, next)) p.activePiece = next;
      else lockPiece(room, p, operations);
    }
    if (!operations.length) {
      operations.push({ type: 'active', playerId: p.id, activePiece: { ...p.activePiece } });
    }
    publishEvent(room, p, action, inputSeq, operations);
    if (p.gameOver) finish(room, room.players.find(other => other.id !== p.id)?.id ?? null, 'top_out');
  }

  function expireDisconnected(room, now) {
    const expired = room.players.filter(p => !p.connected && now - p.disconnectedAt >= reconnectMs);
    if (!expired.length) return false;
    if (room.status === 'waiting') {
      rooms.delete(room.id);
    } else if (room.status !== 'finished') {
      // 双方都离线时不宣布离线玩家获胜，直接结束为无胜者。
      finish(room, room.players.find(p => p.connected)?.id ?? null, 'reconnect_timeout');
    }
    return true;
  }

  io.on('connection', socket => {
    // 令牌桶限流，同时限制加入、指令和快照请求，避免事件洪泛。
    let budget = 120;
    let budgetAt = Date.now();
    let lastSnapshotAt = 0;
    function allowed(cost = 1) {
      const now = Date.now();
      budget = Math.min(120, budget + (now - budgetAt) * 0.06);
      budgetAt = now;
      if (budget < cost) return false;
      budget -= cost;
      return true;
    }
    function reply(ack, data) {
      if (typeof ack === 'function') ack(data);
      else if (!data.ok) socket.emit('room:error', data);
    }
    const fail = (ack, code, message, extra = {}) => reply(ack, { ok: false, code, message, ...extra });
    function membership() {
      const room = rooms.get(socket.data.roomId);
      const player = room?.players.find(p => p.id === socket.data.playerId && p.socketId === socket.id);
      return player ? { room, player } : null;
    }

    socket.on('room:join', (payload, ack) => {
      if (!allowed(10)) return fail(ack, 'RATE_LIMIT', '操作过于频繁，请稍后重试');
      if (!payload || typeof payload !== 'object' || typeof payload.roomId !== 'string' || !/^\d{4}$/.test(payload.roomId)) {
        return fail(ack, 'INVALID_ROOM', '房间号必须是 4 位数字字符串，例如 0123');
      }
      const { roomId, resumeToken } = payload;
      if (socket.data.roomId) {
        return fail(ack, 'ALREADY_JOINED', '当前连接已加入房间，请勿重复加入');
      }
      let room = rooms.get(roomId);
      if (room) expireDisconnected(room, Date.now());
      room = rooms.get(roomId);
      let player;
      if (resumeToken !== undefined) {
        player = room?.players.find(p => tokenMatches(p.resumeToken, resumeToken));
        if (!player) return fail(ack, 'RESUME_FAILED', '恢复凭证无效或房间已过期');
        // 已过重连期限的已结束对局仍可查看最终快照，但不会复活战局。
      } else {
        if (room?.players.length >= 2) return fail(ack, 'ROOM_FULL', '房间已满');
        if (room && room.status !== 'waiting') return fail(ack, 'ROOM_CLOSED', '本局已结束，请换一个房间号');
        if (!room) {
          if (rooms.size >= MAX_ROOMS) return fail(ack, 'SERVER_BUSY', '服务器繁忙，请稍后重试');
          room = {
            id: roomId, matchId: randomUUID(), status: 'waiting', players: [],
            sequence: [], sequenceBase: 0, eventSeq: 0,
            createdAt: Date.now(), finishedAt: null, winnerId: null, reason: null,
            elapsedMs: 0, rematchReady: [],
          };
          rooms.set(roomId, room);
        }
        player = makePlayer(socket.id);
        room.players.push(player);
      }

      // 刷新页面时旧连接可能尚未超时。先换绑定，再踢旧连接，防止误判新连接掉线。
      const oldSocketId = player.socketId;
      player.socketId = socket.id;
      player.connected = true;
      player.disconnectedAt = null;
      socket.data.roomId = roomId;
      socket.data.playerId = player.id;
      socket.join(channel(room));
      if (oldSocketId !== socket.id) io.sockets.sockets.get(oldSocketId)?.disconnect(true);

      // 凭证只通过自己的确认回调返回，前端需保存；不用 room:state 广播凭证。
      const joined = { ok: true, roomId, playerId: player.id, resumeToken: player.resumeToken };
      if (typeof ack === 'function') ack(joined);
      else socket.emit('room:joined', joined);

      if (room.status === 'waiting' && room.players.length === 2) {
        if (room.players.every(p => p.connected)) {
          room.status = 'playing';
          for (const p of room.players) spawn(room, p, []);
          sendSnapshots(room, 'game:start');
        } else {
          // 第一个玩家等待期间掉线，第二个人进来时也先暂停，保留原玩家席位。
          room.status = 'paused';
          for (const p of room.players) spawn(room, p, []);
          sendSnapshots(room, 'game:snapshot');
        }
      } else {
        if (room.status === 'paused' && room.players.every(p => p.connected)) room.status = 'playing';
        // 暂停恢复时双方一起校准，清理客户端残留的预测操作。
        sendSnapshots(room, 'game:snapshot');
      }
      publishRoom(room);
    });

    socket.on('game:command', (payload, ack) => {
      if (!allowed()) return fail(ack, 'RATE_LIMIT', '操作过于频繁');
      const member = membership();
      if (!member) return fail(ack, 'NOT_JOINED', '请先加入房间');
      const { room, player } = member;
      if (!payload || !ACTIONS.has(payload.action) || !Number.isSafeInteger(payload.seq) || payload.seq <= 0) {
        return fail(ack, 'INVALID_COMMAND', '只接受移动、旋转和下落指令；消行由服务端计算');
      }
      // 重连可能重发旧消息：不重复执行，确保硬降不会多生成一次方块。
      if (payload.seq <= player.lastInputSeq) {
        return reply(ack, { ok: true, duplicate: true, lastInputSeq: player.lastInputSeq, eventSeq: room.eventSeq });
      }
      if (room.status !== 'playing') return fail(ack, 'NOT_PLAYING', '对局未开始、已暂停或已结束');
      if (payload.seq !== player.lastInputSeq + 1) {
        return fail(ack, 'SEQ_GAP', '指令序号不连续，请请求快照后恢复', { expectedSeq: player.lastInputSeq + 1 });
      }
      player.lastInputSeq = payload.seq;
      simulate(room, player, payload.action, payload.seq);
      reply(ack, { ok: true, lastInputSeq: player.lastInputSeq, eventSeq: room.eventSeq });
    });

    socket.on('game:resync', (_payload, ack) => {
      if (!allowed(10) || Date.now() - lastSnapshotAt < 1000) return fail(ack, 'RATE_LIMIT', '请勿频繁请求快照');
      const member = membership();
      if (!member) return fail(ack, 'NOT_JOINED', '请先加入房间');
      lastSnapshotAt = Date.now();
      socket.emit('game:snapshot', snapshot(member.room, member.player));
      reply(ack, { ok: true });
    });

    // 浏览器测量请求往返时间（RTT），不把它冒充单程延迟。
    socket.on('net:ping', (_payload, ack) => {
      if (!allowed(2)) return fail(ack, 'RATE_LIMIT', '请求过于频繁');
      reply(ack, { ok: true, serverTime: Date.now() });
    });

    socket.on('room:leave', (_payload, ack) => {
      const member = membership();
      if (!member) return reply(ack, { ok: true });
      const { room, player } = member;
      if (room.status === 'waiting') rooms.delete(room.id);
      else if (room.status !== 'finished') {
        finish(room, room.players.find(p => p.id !== player.id)?.id ?? null, 'surrender');
      }
      player.connected = false;
      player.disconnectedAt = Date.now();
      player.socketId = null;
      // 主动离开后凭证作废；结束房间仍保留给对手查看结果。
      player.resumeToken = randomBytes(32).toString('hex');
      room.rematchReady = (room.rematchReady || []).filter(id => id !== player.id);
      socket.leave(channel(room));
      socket.data.roomId = null;
      socket.data.playerId = null;
      if (rooms.has(room.id)) publishRoom(room);
      reply(ack, { ok: true });
    });

    socket.on('game:rematch', (_payload, ack) => {
      if (!allowed(10)) return fail(ack, 'RATE_LIMIT', '操作过于频繁');
      const member = membership();
      if (!member) return fail(ack, 'NOT_JOINED', '请先加入房间');
      const { room, player } = member;
      if (room.status !== 'finished') return fail(ack, 'NOT_FINISHED', '本局尚未结束');
      if (!room.players.every(p => p.connected)) return fail(ack, 'OPPONENT_OFFLINE', '对手已离开，请返回菜单更换房间');
      if (!room.rematchReady.includes(player.id)) room.rematchReady.push(player.id);
      reply(ack, { ok: true });
      if (room.rematchReady.length < 2) { publishRoom(room); return; }
      room.matchId = randomUUID(); room.eventSeq = 0; room.elapsedMs = 0;
      room.sequence = []; room.sequenceBase = 0; room.rematchReady = [];
      room.winnerId = null; room.reason = null; room.finishedAt = null;
      room.status = 'playing';
      for (const p of room.players) {
        const identity = { id: p.id, resumeToken: p.resumeToken, socketId: p.socketId };
        Object.assign(p, makePlayer(p.socketId), identity);
      }
      for (const p of room.players) spawn(room, p, []);
      sendSnapshots(room, 'game:start'); publishRoom(room);
    });

    socket.on('disconnect', () => {
      const member = membership();
      if (!member) return;
      const { room, player } = member;
      player.connected = false;
      player.disconnectedAt = Date.now();
      if (room.status === 'playing') room.status = 'paused';
      publishRoom(room);
    });
  });

  // 统一时钟驱动重力和过期清理，避免每个方块/房间创建大量 setTimeout。
  // 暂停期间不累积重力时间，重连后不会瞬间下落一大截。
  let previousTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.min(now - previousTick, 100);
    previousTick = now;
    for (const room of rooms.values()) {
      expireDisconnected(room, now);
      if (!rooms.has(room.id)) continue;
      if ((room.status === 'waiting' && now - room.createdAt > WAIT_TTL_MS) ||
          (room.status === 'finished' && now - room.finishedAt > FINISHED_TTL_MS)) {
        io.to(channel(room)).emit('room:expired', { roomId: room.id, message: '房间已过期，请重新连接并加入新房间' });
        io.in(channel(room)).disconnectSockets(true);
        rooms.delete(room.id);
        continue;
      }
      if (room.status !== 'playing') continue;
      room.elapsedMs += elapsed;
      for (const p of room.players) {
        if (room.status !== 'playing') break;
        p.fallElapsed += elapsed;
        if (p.fallElapsed >= FALL_MS) {
          p.fallElapsed -= FALL_MS;
          simulate(room, p, 'gravity');
        }
      }
    }
  }, 50);
  timer.unref();

  // 导出构造函数便于自动化测试；导入时不占用端口。
  async function close() {
    clearInterval(timer);
    await new Promise(resolve => io.close(resolve));
  }
  return { app, server, io, rooms, close };
}

if (require.main === module) {
  const instance = createGameServer();
  const port = Number(process.env.PORT || 3000);
  instance.server.listen(port, '0.0.0.0', () => {
    console.log(`俄罗斯方块服务已启动：http://localhost:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await instance.close(); process.exit(0); });
  }
}

module.exports = { createGameServer };
