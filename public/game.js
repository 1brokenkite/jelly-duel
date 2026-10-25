'use strict';

/**
 * 单人练习 + Socket.io 双人联机 + Canvas 渲染 + 页面状态机。
 * 无 setInterval；所有计时统一由 requestAnimationFrame 的 timestamp 驱动。
 * 联机只由服务端快照/增量推进权威棋盘；本地预测只用于即时反馈。
 * 原始权威状态与预测画面分离，确认后重放未确认操作，不会执行两次硬降。
 */
(() => {
  const WIDTH = 10, HEIGHT = 22, HIDDEN = 2, FALL_MS = 800;
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  // 与 server.js 的定义、旋转方向、隐藏行和简单踢墙规则一致。
  const SHAPES = {
    I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    O: [[1, 1], [1, 1]],
    T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
    Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
    L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  };
  const COLORS = [null, ['#d4f4f2', '#91cfcf'], ['#fff1c6', '#e9cc83'],
    ['#e8dcff', '#b7a0e0'], ['#dbf3d9', '#a2d3a1'], ['#ffdee7', '#e9a8bc'],
    ['#dce8ff', '#9db9e8'], ['#ffe7d4', '#edbd94'], ['#e3e7ef', '#a7b1c5']];
  const ACTIONS = new Set(['left', 'right', 'rotateCW', 'rotateCCW', 'softDrop', 'hardDrop']);
  const blankBoard = () => Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(0));

  function cells(piece) {
    let shape = SHAPES[piece.type];
    for (let r = 0; r < piece.rotation; r++) shape = shape[0].map((_, x) => shape.map(row => row[x]).reverse());
    return shape.flatMap((row, y) => row.flatMap((value, x) => value ? [{ x: piece.x + x, y: piece.y + y }] : []));
  }

  class LocalGame {
    constructor(random = Math.random) { this.random = random; this.reset(); }
    reset(demo = false) {
      this.board = blankBoard(); this.queue = []; this.active = null;
      this.lines = 0; this.score = 0; this.fallElapsed = 0; this.elapsed = 0;
      this.over = false; this.won = false; this.clearAnimation = null; this.demo = demo;
      this.fillQueue(); this.spawn();
      if (demo) {
        // 可重复的视觉验收场景：竖直 I 块补齐底部四行，按硬降即可体验动画。
        for (let y = HEIGHT - 4; y < HEIGHT; y++) this.board[y] = Array.from({ length: WIDTH }, (_, x) => x === 4 ? 0 : (y % 7) + 1);
        this.active = { type: 'I', rotation: 1, x: 2, y: 0 };
      }
    }
    fillQueue() {
      while (this.queue.length < 6) {
        const bag = [...TYPES];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        this.queue.push(...bag);
      }
    }
    fits(piece) {
      return cells(piece).every(({ x, y }) => x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && this.board[y][x] === 0);
    }
    spawn() {
      this.fillQueue();
      const type = this.queue.shift();
      this.active = { type, rotation: 0, x: Math.floor((WIDTH - SHAPES[type].length) / 2), y: 0 };
      this.fallElapsed = 0;
      if (!this.fits(this.active)) this.over = true;
    }
    ghost() {
      if (!this.active) return null;
      const piece = { ...this.active };
      while (this.fits({ ...piece, y: piece.y + 1 })) piece.y++;
      return piece;
    }
    command(action) {
      if (this.over || this.clearAnimation || !this.active || !ACTIONS.has(action)) return false;
      const next = { ...this.active };
      if (action === 'left' || action === 'right') {
        next.x += action === 'left' ? -1 : 1;
        if (this.fits(next)) this.active = next;
      } else if (action === 'rotateCW' || action === 'rotateCCW') {
        next.rotation = (next.rotation + (action === 'rotateCW' ? 1 : 3)) % 4;
        for (const dx of [0, -1, 1, -2, 2]) {
          const candidate = { ...next, x: next.x + dx };
          if (this.fits(candidate)) { this.active = candidate; break; }
        }
      } else if (action === 'hardDrop') {
        this.active = this.ghost(); this.lock();
      } else {
        next.y++;
        if (this.fits(next)) this.active = next;
        else this.lock();
      }
      return true;
    }
    lock() {
      const value = TYPES.indexOf(this.active.type) + 1;
      for (const { x, y } of cells(this.active)) this.board[y][x] = value;
      this.active = null;
      const rows = this.board.flatMap((row, y) => row.every(Boolean) ? [y] : []);
      if (rows.length) {
        // 规则立即结算，动画使用独立旧棋盘，不把视觉插值写回碰撞数据。
        const before = this.board.map(row => [...row]);
        this.board = this.board.filter((_, y) => !rows.includes(y));
        while (this.board.length < HEIGHT) this.board.unshift(Array(WIDTH).fill(0));
        this.lines += rows.length;
        this.score += [0, 100, 300, 500, 800][rows.length] ?? rows.length * 200;
        this.clearAnimation = { before, rows, elapsed: 0, duration: 360 };
      } else this.finishLock();
    }
    finishLock() {
      if (this.board.slice(0, HIDDEN).some(row => row.some(Boolean))) { this.over = true; return; }
      if (this.demo && this.lines >= 4) { this.over = true; this.won = true; return; }
      this.spawn();
    }
    update(dt, reducedMotion = false) {
      if (this.over) return;
      this.elapsed += dt;
      if (this.clearAnimation) {
        this.clearAnimation.elapsed += dt;
        if (this.clearAnimation.elapsed >= (reducedMotion ? 80 : this.clearAnimation.duration)) {
          this.clearAnimation = null; this.finishLock();
        }
        return;
      }
      this.fallElapsed += dt;
      while (this.fallElapsed >= FALL_MS && !this.over && !this.clearAnimation) {
        this.fallElapsed -= FALL_MS;
        this.command('softDrop'); // 本地自然重力，不是玩家指令，不发送网络消息。
      }
    }
  }

  /** 同源 Socket.io 发送器：离线不发送，以免恢复后执行过期指令。 */
  function createSocketCommandSender(socket, onReply) {
    return command => {
      if (!socket.connected) return false; // 不往 Socket.io 离线缓冲区写过期操作。
      socket.emit('game:command', command, onReply);
      return true;
    };
  }

  // 纯数据同步器，既供浏览器使用，也可在 Node.js 测试乱序、重放和垃圾行。
  class NetworkState {
    constructor() { this.players = new Map(); this.pending = []; this.matchId = null; this.eventSeq = 0; this.seq = 0; }
    snapshot(data, preservePending = false) {
      const sameMatch = data.matchId === this.matchId;
      this.selfId = data.selfId; this.matchId = data.matchId; this.eventSeq = data.eventSeq;
      this.players = new Map(data.players.map(p => [p.playerId, structuredClone(p)]));
      const last = this.players.get(this.selfId).lastInputSeq;
      // 对手重连也会发送快照。仍在途的本方操作不能丢弃，否则会重复使用序号。
      this.pending = preservePending && sameMatch ? this.pending.filter(p => p.seq > last) : [];
      this.seq = Math.max(last, ...this.pending.map(p => p.seq));
    }
    apply(event) {
      if (event.matchId !== this.matchId || event.eventSeq <= this.eventSeq) return 'old';
      if (event.eventSeq !== this.eventSeq + 1) return 'gap';
      const animations = [];
      for (const op of event.operations) {
        const p = this.players.get(op.playerId);
        if (!p) return 'gap';
        const remove = rows => {
          p.board = p.board.filter((_, y) => !rows.includes(y));
          p.garbageRows = p.garbageRows.filter((_, y) => !rows.includes(y));
          while (p.board.length < HEIGHT) { p.board.unshift(Array(WIDTH).fill(0)); p.garbageRows.unshift(false); }
        };
        switch (op.type) {
          case 'active': p.activePiece = { ...op.activePiece }; break;
          case 'lock':
            for (const { x, y } of op.cells) p.board[y][x] = op.value;
            p.activePiece = null; break;
          case 'clear':
            animations.push({ playerId: p.playerId, before: structuredClone(p.board), rows: op.rows, elapsed: 0, duration: 360 });
            remove(op.rows); p.score = op.score; p.lines = op.lines; break;
          case 'garbage:remove': remove(op.rows); break;
          case 'garbage:cancel': p.pendingGarbage.splice(0, op.count); break;
          case 'garbage:queue': p.pendingGarbage.push(...structuredClone(op.rows)); break;
          case 'garbage:insert':
            for (const { holes } of op.rows) {
              p.board.shift(); p.board.push(Array.from({ length: WIDTH }, (_, x) => holes.includes(x) ? 0 : 8));
              p.garbageRows.shift(); p.garbageRows.push(true);
            }
            p.pendingGarbage = []; break;
          case 'spawn': p.activePiece = { ...op.activePiece }; p.nextQueue = [...op.nextQueue]; break;
          default: return 'gap';
        }
      }
      this.eventSeq = event.eventSeq;
      if (event.inputSeq !== null) {
        this.players.get(event.playerId).lastInputSeq = event.inputSeq;
        if (event.playerId === this.selfId) this.pending = this.pending.filter(p => p.seq > event.inputSeq);
      }
      return animations;
    }
    predict(target) {
      const source = this.players.get(this.selfId);
      if (!source) return;
      target.board = structuredClone(source.board);
      target.active = source.activePiece ? { ...source.activePiece } : null;
      target.queue = [...source.nextQueue]; target.score = source.score; target.lines = source.lines;
      target.over = source.gameOver; target.clearAnimation = null;
      // 使用同一碰撞/旋转算法；预测锁定不抽取随机块、不生成攻击、不决定胜负。
      const lock = target.lock;
      target.lock = function () {
        const value = TYPES.indexOf(this.active.type) + 1;
        for (const { x, y } of cells(this.active)) this.board[y][x] = value;
        this.active = null;
      };
      try { for (const command of this.pending) target.command(command.action); }
      finally { target.lock = lock; }
    }
  }
  // 同一文件可在 Node.js 中验证规则；浏览器使用下方 DOM/Canvas 部分。
  if (typeof module !== 'undefined' && module.exports) module.exports = { LocalGame, NetworkState, cells, createSocketCommandSender };
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const game = new LocalGame();
  let opponentBoard = blankBoard();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ui = {
    phase: 'menu', paused: false, countdown: 3000, demo: false,
    inputSeq: 0, mode: 'solo',
  };
  const transitions = { menu: ['waiting'], waiting: ['playing', 'result', 'menu'], playing: ['result', 'menu', 'waiting'], result: ['waiting', 'playing', 'menu'] };
  const net = {
    socket: null, model: new NetworkState(), joined: false, syncing: false,
    auth: null, room: null, epoch: 0, animations: new Map(),
    clockOffset: 0, resyncAt: 0, pingAt: 0, pingBusy: false,
  };
  const held = new Map();
  let frameAt = null;

  class Surface {
    constructor(id) {
      this.canvas = $(id); this.ctx = this.canvas.getContext('2d'); this.width = 0; this.height = 0;
    }
    prepare() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = rect.width; this.height = rect.height;
      if (!this.width || !this.height) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.round(this.width * dpr), height = Math.round(this.height * dpr);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width; this.canvas.height = height;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, this.width, this.height);
      return true;
    }
  }
  const surfaces = Object.fromEntries(['board', 'opponent', 'mini', 'next', 'result'].map(key => [key, new Surface(`${key}-canvas`)]));
  let palette;
  function updatePalette() {
    const styles = getComputedStyle(document.documentElement);
    palette = { board: styles.getPropertyValue('--board').trim(), line: styles.getPropertyValue('--line').trim() };
  }
  function rounded(ctx, x, y, w, h, radius) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(radius, w / 2, h / 2));
  }
  function block(ctx, x, y, size, value, scale = 1, alpha = 1, ghost = false) {
    if (scale <= 0 || alpha <= 0) return;
    const gap = Math.max(.7, size * .065), edge = (size - 2 * gap) * scale;
    const px = x + (size - edge) / 2, py = y + (size - edge) / 2;
    const [light, base] = COLORS[value];
    ctx.save(); ctx.globalAlpha = alpha;
    rounded(ctx, px, py, edge, edge, size * .2);
    if (ghost) {
      ctx.fillStyle = `${base}20`; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = `${base}80`; ctx.stroke();
    } else {
      const gradient = ctx.createLinearGradient(px, py, px + edge * .3, py + edge);
      gradient.addColorStop(0, light); gradient.addColorStop(1, base);
      ctx.shadowColor = `${base}65`; ctx.shadowBlur = size * .2;
      ctx.fillStyle = gradient; ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff70'; ctx.lineWidth = Math.max(.5, size * .025); ctx.stroke();
      // 很轻的上沿高光，保留软糖感而不使用高对比立体边框。
      if (size > 10) { ctx.fillStyle = '#ffffff40'; rounded(ctx, px + edge * .18, py + edge * .12, edge * .64, Math.max(1, edge * .06), 2); ctx.fill(); }
    }
    ctx.restore();
  }
  function drawBoard(surface, board, active = null, animation = null, ghost = null) {
    if (!surface.prepare()) return;
    const { ctx, width, height } = surface, size = width / WIDTH;
    ctx.fillStyle = palette.board; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = palette.line; ctx.lineWidth = .5;
    ctx.beginPath();
    for (let x = 1; x < WIDTH; x++) { ctx.moveTo(x * size, 0); ctx.lineTo(x * size, height); }
    for (let y = 1; y < HEIGHT - HIDDEN; y++) { ctx.moveTo(0, y * size); ctx.lineTo(width, y * size); }
    ctx.stroke();
    const progress = animation ? Math.min(1, animation.elapsed / animation.duration) : 0;
    const source = animation ? animation.before : board;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (!source[y][x]) continue;
        let offset = 0, scale = 1, alpha = 1;
        if (animation) {
          if (animation.rows.includes(y)) {
            const collapse = Math.min(1, progress / .65);
            scale = 1 - collapse * collapse; alpha = 1 - collapse;
          } else {
            const fall = Math.max(0, (progress - .4) / .6);
            const ease = 1 - (1 - fall) ** 3;
            offset = animation.rows.filter(row => row > y).length * ease;
          }
        }
        block(ctx, x * size, (y - HIDDEN + offset) * size, size, source[y][x], scale, alpha);
      }
    }
    if (ghost) for (const { x, y } of cells(ghost)) if (y >= HIDDEN) block(ctx, x * size, (y - HIDDEN) * size, size, TYPES.indexOf(ghost.type) + 1, 1, 1, true);
    if (active) for (const { x, y } of cells(active)) if (y >= HIDDEN) block(ctx, x * size, (y - HIDDEN) * size, size, TYPES.indexOf(active.type) + 1);
  }
  function drawNext() {
    const surface = surfaces.next;
    if (!surface.prepare() || ui.phase === 'menu' || !game.queue[0]) return;
    const type = game.queue[0], points = cells({ type, x: 0, y: 0, rotation: 0 });
    const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
    const cols = Math.max(...points.map(p => p.x)) - left + 1, rows = Math.max(...points.map(p => p.y)) - top + 1;
    const size = Math.min(surface.width / 5, surface.height / 3);
    for (const { x, y } of points) block(surface.ctx, (surface.width - cols * size) / 2 + (x - left) * size, (surface.height - rows * size) / 2 + (y - top) * size, size, TYPES.indexOf(type) + 1);
  }
  // 缓存静态棋盘，避免每一帧重画完全不变的对手区域。
  let staticDirty = true;
  new ResizeObserver(() => { staticDirty = true; }).observe(document.querySelector('.arena'));
  function render() {
    const ownAnimation = ui.mode === 'online' ? net.animations.get(net.model.selfId) : game.clearAnimation;
    drawBoard(surfaces.board, game.board, ui.phase === 'menu' ? null : game.active, ownAnimation, ui.phase === 'playing' ? game.ghost() : null);
    drawNext();
    if (ui.mode === 'online') {
      const opponent = otherPlayer();
      opponentBoard = opponent?.board || blankBoard();
      for (const key of ['opponent', 'mini']) drawBoard(surfaces[key], opponentBoard, opponent?.activePiece, net.animations.get(opponent?.playerId));
      if (staticDirty) drawBoard(surfaces.result, opponentBoard);
      staticDirty = false;
      return;
    }
    if (staticDirty) {
      for (const key of ['opponent', 'mini', 'result']) drawBoard(surfaces[key], opponentBoard);
      staticDirty = false;
    }
  }
  function write(id, value) { const el = $(id); if (el.textContent !== String(value)) el.textContent = value; }
  function refreshHud() {
    write('score', game.score.toLocaleString()); write('lines', game.lines); write('level', 1);
    const seconds = Math.floor(game.elapsed / 1000);
    if (ui.mode === 'online') {
      write('timer', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
      if (net.room?.status === 'paused') {
        const deadlines = net.room.players.filter(p => !p.connected).map(p => p.reconnectDeadline).filter(Boolean);
        if (deadlines.length) write('cover-description', `剩余 ${Math.max(0, Math.ceil((Math.min(...deadlines) - Date.now() - net.clockOffset) / 1000))} 秒，恢复后自动继续`);
      }
      return;
    }
    write('timer', ui.phase === 'waiting' ? Math.max(1, Math.ceil(ui.countdown / 1000)) : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
    if (ui.phase === 'waiting' && !ui.paused) write('cover-title', Math.max(1, Math.ceil(ui.countdown / 1000)));
  }
  function resetInput() {
    held.clear();
    document.querySelectorAll('.pressed').forEach(button => button.classList.remove('pressed'));
  }
  function announce(text) { write('announcement', text); }
  function setPhase(next) {
    if (next === ui.phase) return;
    if (!transitions[ui.phase].includes(next)) throw new Error(`非法状态切换：${ui.phase} -> ${next}`);
    ui.phase = next; ui.paused = false; resetInput(); frameAt = null;
    $('menu-layer').hidden = next !== 'menu'; $('result-layer').hidden = next !== 'result';
    document.querySelector('.shell').inert = next === 'menu' || next === 'result';
    document.querySelector('.touch-controls').inert = next !== 'playing';
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = next !== 'playing'; });
    $('pause-button').disabled = next !== 'playing' || ui.mode === 'online'; $('menu-button').disabled = next === 'menu' || next === 'result';
    $('resume-button').hidden = true; $('board-cover').hidden = next !== 'waiting';
    $('cover-title').classList.toggle('countdown-number', next === 'waiting');
    write('pause-button', '暂停'); write('timer-label', next === 'waiting' ? '准备开始' : '练习时间');
    write('phase-label', { menu: '等待开始', waiting: '单人准备中', playing: '单人练习', result: '本局结束' }[next]);
    write('self-status', { menu: '准备就绪', waiting: '准备中', playing: '练习中', result: '已结束' }[next]);
    if (next === 'waiting') { write('cover-title', '3'); write('cover-description', ui.demo ? '按硬降，体验四行消除' : '深呼吸，准备好了吗？'); $('menu-button').focus(); }
    if (next === 'playing') { announce(ui.mode === 'online' ? '对战开始' : '练习开始'); document.activeElement?.blur(); }
    if (next === 'menu') $('room-input').focus();
    if (next === 'result') {
      write('result-title', game.won ? '挑战成功！' : '这局结束，下一局更好。');
      write('result-copy', game.won ? '漂亮！四行软糖一起消失了。你已完成消行练习。' : '方块堆到顶部，本次挑战失败。调整节奏，再试一次。');
      write('result-score', game.score.toLocaleString()); $('retry-button').focus();
      announce(game.won ? '挑战成功' : '挑战失败');
    }
    staticDirty = true;
  }
  function start(demo) {
    ui.mode = 'solo'; resetOnlineDisplay();
    const roomId = $('room-input').value.trim();
    ui.demo = demo; ui.inputSeq = 0; ui.countdown = 3000; game.reset(demo);
    write('room-tag', /^\d{4}$/.test(roomId) ? `预留房间 ${roomId}` : 'SOLO / 单人');
    write('game-hint', demo ? '消行练习：按空格或触屏「硬降」，消除四行。' : '把空隙填满，让快乐加分。');
    setPhase('waiting'); refreshHud();
  }
  function togglePause(force = false) {
    if (ui.mode === 'online') { resetInput(); return; } // 切后台不能单方面暂停对手；真正掉线才由服务端暂停。
    if (ui.phase !== 'playing' && ui.phase !== 'waiting') return;
    ui.paused = force ? true : !ui.paused; resetInput(); frameAt = null;
    $('board-cover').hidden = !ui.paused && ui.phase !== 'waiting';
    $('cover-title').classList.toggle('countdown-number', !ui.paused && ui.phase === 'waiting');
    write('cover-title', ui.paused ? '休息一下' : Math.max(1, Math.ceil(ui.countdown / 1000)));
    write('cover-description', ui.paused ? '准备好后，点击继续或按 P' : '准备开始');
    $('resume-button').hidden = !ui.paused;
    write('pause-button', ui.paused ? '继续' : '暂停');
    write('phase-label', ui.paused ? '已暂停' : ui.phase === 'waiting' ? '单人准备中' : '单人练习');
    write('self-status', ui.paused ? '已暂停' : '练习中');
    if (ui.paused) $('resume-button').focus(); else document.activeElement?.blur();
  }
  function dispatch(action) {
    if (ui.phase !== 'playing' || ui.paused) return;
    if (ui.mode === 'online') { sendCommand(action); return; }
    if (!game.command(action)) return;
    ui.inputSeq++; // 单人模式只更新本地；联机分支在上方发送真实指令。
  }
  const AUTH_KEY = 'jelly-room-session-v1';
  function saveAuth(auth) {
    net.auth = auth;
    try { if (auth) sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth)); else sessionStorage.removeItem(AUTH_KEY); }
    catch { /* 存储被禁用时仍可在当前页面重连，但刷新无法保留身份。 */ }
  }
  function otherPlayer() { return [...net.model.players.values()].find(p => p.playerId !== net.model.selfId); }
  function resetOnlineDisplay() {
    $('pause-button').hidden = false;
    opponentBoard = blankBoard(); net.animations.clear(); staticDirty = true;
    $('opponent-cover').hidden = false; $('invite-button').hidden = true;
    write('mode-badge', '本地练习'); write('network-note', '本地运行'); write('latency', '—');
    write('opponent-status', '未连接'); write('opponent-note', '尚无对手');
    for (const id of ['opponent-score', 'opponent-lines', 'opponent-garbage']) write(id, '—');
    write('result-opponent-note', '单人模式 · 本局没有对手'); write('rematch-note', '');
    $('retry-button').disabled = false; write('retry-button', '再来一局');
  }
  function networkNotice(title, description = '') {
    $('board-cover').hidden = false; $('resume-button').hidden = true;
    $('cover-title').classList.remove('countdown-number');
    write('cover-title', title); write('cover-description', description);
    write('phase-label', title);
  }
  function refreshOnline() {
    if (ui.mode !== 'online') return;
    const room = net.room, opponent = otherPlayer();
    const canPlay = net.joined && !net.syncing && net.socket?.connected && room?.status === 'playing';
    ui.paused = !canPlay;
    document.querySelectorAll('[data-action]').forEach(button => { button.disabled = !canPlay; });
    $('pause-button').hidden = true;
    $('invite-button').hidden = !net.auth || ui.phase === 'result';
    write('mode-badge', '双人实时对战'); write('timer-label', '对局时间');
    write('room-tag', `房间 ${net.auth?.roomId || $('room-input').value}`);
    write('self-status', canPlay ? '对战中' : net.joined ? '等待中' : '连接中');
    $('opponent-cover').hidden = !!opponent;
    $('opponent-dot').classList.toggle('idle', !opponent?.connected);
    write('opponent-status', opponent ? opponent.connected ? '已连接' : '掉线中' : '等待加入');
    write('opponent-note', opponent ? `得分 ${opponent.score} · ${opponent.connected ? '在线' : '重连中'}` : '等待朋友加入');
    write('opponent-score', opponent?.score ?? '—'); write('opponent-lines', opponent?.lines ?? '—');
    write('opponent-garbage', opponent?.pendingGarbage.length ?? '—');
    const own = net.model.players.get(net.model.selfId);
    write('game-hint', own?.pendingGarbage.length ? `待入垃圾 ${own.pendingGarbage.length} 行，消行可优先抵消。` : '同一套方块，不同的节奏。消行向对手发起攻击。');
    if (!net.socket?.connected) networkNotice('连接中，等待恢复', '正在自动重连，恢复后自动同步棋盘');
    else if (!net.joined || net.syncing) networkNotice('正在同步战局', '请稍候');
    else if (room?.status === 'waiting') networkNotice('等待朋友加入', `请朋友输入房间号 ${room.roomId}`);
    else if (room?.status === 'paused') networkNotice('对手掉线，等待重连');
    else if (room?.status === 'playing') { $('board-cover').hidden = true; write('phase-label', '双人对战'); }
    if (room?.status === 'finished' && ui.phase === 'result') {
      const ready = room.rematchReady || [];
      const meReady = ready.includes(net.model.selfId);
      $('retry-button').disabled = meReady || !opponent?.connected || !net.joined;
      write('retry-button', meReady ? '已准备，等待对手' : '再来一局');
      write('rematch-note', !opponent?.connected ? '对手已离开，可返回菜单更换房间。' : meReady ? '对手也点击“再来一局”后重新开始。' : ready.length ? '对手想再来一局，点击即可开局。' : '双方同意后，在原房间重新开始。');
    }
  }
  function stopSocket() {
    net.epoch++;
    if (net.socket) { net.socket.removeAllListeners(); net.socket.disconnect(); net.socket = null; }
    net.joined = false; net.syncing = false; net.pingBusy = false;
    net.model.pending = []; resetInput();
  }
  function returnToMenu(message = '') {
    stopSocket(); saveAuth(null); net.room = null; net.model = new NetworkState();
    ui.mode = 'solo'; game.reset(); resetOnlineDisplay(); $('pause-button').hidden = false;
    setPhase('menu'); write('mode-badge', '双人对战 / 单人练习');
    write('room-note', message || '第一位玩家创建房间，第二位加入即开始。');
    $('room-note').classList.toggle('error', !!message);
  }
  async function leaveOnline() {
    resetInput(); net.joined = false; refreshOnline();
    const socket = net.socket;
    if (socket?.connected) {
      // 有界等待让主动离开先抵达服务端；失败时仍以掉线保留 30 秒，不会永久占房。
      await new Promise(resolve => socket.timeout(2000).emit('room:leave', {}, () => resolve()));
    }
    returnToMenu();
  }
  function requestResync() {
    if (ui.mode !== 'online' || !net.socket?.connected || !net.joined) return;
    net.syncing = true; resetInput(); refreshOnline();
    if (performance.now() < net.resyncAt) return;
    net.resyncAt = performance.now() + 1500;
    const epoch = net.epoch;
    net.socket.timeout(4000).emit('game:resync', {}, (error, result) => {
      if (epoch !== net.epoch) return;
      if (result?.code === 'NOT_JOINED') { net.socket.disconnect(); net.socket.connect(); }
      // 限流/超时继续保持禁用输入，由下一帧在间隔到期后重试。
    });
  }
  function receiveSnapshot(data) {
    if (ui.mode !== 'online' || !net.auth || data.roomId !== net.auth.roomId) return;
    if (data.matchId === net.model.matchId && data.eventSeq < net.model.eventSeq) return;
    net.model.snapshot(data, net.joined && !net.syncing);
    net.joined = true; net.syncing = false; net.room = data;
    net.clockOffset = data.serverTime - Date.now();
    net.animations.clear(); net.model.predict(game); game.elapsed = data.elapsedMs || 0;
    if (data.status === 'finished') {
      setPhase('result');
      const won = data.winnerId === data.selfId, drawn = !data.winnerId;
      write('result-title', drawn ? '本局结束' : won ? '你赢了！' : '这次惜败，下局再来。');
      const reason = { top_out: '方块堆到顶部', reconnect_timeout: '重连等待超时', surrender: '玩家主动退出' }[data.reason] || '对局结束';
      write('result-copy', `${reason}。${drawn ? '本局没有胜者。' : won ? '漂亮，守住了自己的阵地！' : '调整节奏，再挑战一次。'}`);
      write('result-score', game.score.toLocaleString()); write('result-opponent-note', '对手本局最终棋盘');
      announce(won ? '你赢了' : '本局结束');
    } else setPhase(data.status === 'playing' ? 'playing' : 'waiting');
    staticDirty = true; refreshOnline();
  }
  function sendCommand(action) {
    if (!net.joined || net.syncing || !net.socket?.connected || net.room?.status !== 'playing' || !game.active || net.model.pending.length >= 32) return;
    const command = { seq: ++net.model.seq, action, sentAt: performance.now() };
    net.model.pending.push(command);
    // 立即预测本方移动；权威事件到达后重建，不直接在预测棋盘上叠加确认结果。
    net.model.predict(game);
    const epoch = net.epoch, matchId = net.model.matchId;
    net.socket.timeout(4000).emit('game:command', { seq: command.seq, action }, (error, result) => {
      if (epoch !== net.epoch || matchId !== net.model.matchId || ui.phase === 'result') return;
      if (error || !result?.ok || (result.eventSeq > net.model.eventSeq && result.duplicate)) requestResync();
    });
  }
  function joinOnline(savedAuth = null) {
    const roomId = savedAuth?.roomId || $('room-input').value.trim();
    if (!/^\d{4}$/.test(roomId)) {
      write('room-note', '请输入 4 位数字房间号，例如 0123。'); $('room-note').classList.add('error');
      $('room-input').setAttribute('aria-invalid', 'true'); $('room-input').focus(); return;
    }
    if (typeof window.io !== 'function') { write('room-note', '连接组件加载失败，请通过服务器网址打开并刷新页面。'); return; }
    stopSocket(); ui.mode = 'online'; net.model = new NetworkState(); net.room = null;
    saveAuth(savedAuth); game.reset(); game.active = null; game.queue = []; game.board = blankBoard();
    net.animations.clear(); net.pingAt = 0; net.resyncAt = 0;
    $('room-input').value = roomId; setPhase('waiting');
    const socket = window.io({ autoConnect: false, reconnection: true, reconnectionAttempts: Infinity,
      reconnectionDelay: 500, reconnectionDelayMax: 2000, randomizationFactor: .5, timeout: 8000 });
    net.socket = socket;
    socket.on('connect', () => {
      net.epoch++; const epoch = net.epoch;
      net.joined = false; net.syncing = false; net.model.pending = []; socket.sendBuffer = [];
      refreshOnline();
      const payload = { roomId, ...(net.auth?.resumeToken ? { resumeToken: net.auth.resumeToken } : {}) };
      socket.timeout(5000).emit('room:join', payload, (error, result) => {
        if (epoch !== net.epoch) return;
        if (error) { socket.disconnect(); socket.connect(); return; }
        if (!result.ok) { returnToMenu(result.message); return; }
        saveAuth({ roomId: result.roomId, playerId: result.playerId, resumeToken: result.resumeToken });
        // ack 先于快照；只有收到快照后才允许操作。
      });
    });
    socket.on('game:start', receiveSnapshot);
    socket.on('game:snapshot', receiveSnapshot);
    socket.on('game:over', receiveSnapshot);
    socket.on('room:state', data => {
      if (!net.auth || data.roomId !== net.auth.roomId || data.matchId !== net.model.matchId) return;
      net.room = data; net.clockOffset = data.serverTime - Date.now(); game.elapsed = data.elapsedMs;
      for (const p of data.players) { const known = net.model.players.get(p.playerId); if (known) Object.assign(known, p); }
      if (data.status !== 'playing') resetInput();
      refreshOnline();
    });
    socket.on('game:event', data => {
      if (!net.joined || net.syncing) return;
      const result = net.model.apply(data);
      if (result === 'gap') { requestResync(); return; }
      if (result === 'old') return;
      // 旧动画不遮住后续已锁定的方块；新的消行事件再创建动画。
      if (data.operations.some(op => op.type === 'lock')) net.animations.delete(data.playerId);
      for (const animation of result) net.animations.set(animation.playerId, animation);
      net.model.predict(game); refreshOnline();
    });
    socket.on('disconnect', reason => {
      net.epoch++; net.joined = false; net.pingBusy = false; net.model.pending = [];
      if (reason === 'io server disconnect') { returnToMenu('连接已关闭，可能已在另一页面恢复或房间已过期。'); return; }
      resetInput(); write('latency', '—'); write('network-note', '重连中'); refreshOnline();
    });
    socket.on('connect_error', () => { write('network-note', '无法连接，正在重试'); refreshOnline(); });
    socket.on('room:expired', data => returnToMenu(data.message));
    socket.on('room:error', data => { write('game-hint', data.message); });
    refreshOnline(); socket.connect();
  }
  function updateNetwork(timestamp, dt) {
    if (!net.socket) return;
    if (net.joined && net.room?.status === 'playing') game.elapsed += dt;
    for (const [id, animation] of net.animations) {
      animation.elapsed += dt;
      if (animation.elapsed >= (reducedMotion.matches ? 80 : animation.duration)) net.animations.delete(id);
    }
    if (net.syncing || net.model.pending.some(p => timestamp - p.sentAt > 4000)) requestResync();
    if (net.socket.connected && net.joined && !net.pingBusy && timestamp >= net.pingAt) {
      net.pingAt = timestamp + 3000; net.pingBusy = true;
      const began = performance.now(), epoch = net.epoch;
      net.socket.timeout(4000).emit('net:ping', {}, (error, response) => {
        if (epoch !== net.epoch) return;
        net.pingBusy = false;
        if (error || !response?.ok) { write('latency', '—'); write('network-note', '网络波动'); return; }
        const rtt = Math.round(performance.now() - began);
        net.clockOffset = response.serverTime - Date.now() + rtt / 2;
        write('latency', `${rtt} ms`); write('network-note', '往返延迟 RTT');
      });
    }
  }
  const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'softDrop', ArrowUp: 'rotateCW', Space: 'hardDrop' };
  function press(id, action) {
    if (held.has(id) || ui.phase !== 'playing' || ui.paused) return;
    dispatch(action);
    if (['left', 'right', 'softDrop'].includes(action)) held.set(id, { action, elapsed: 0, next: action === 'softDrop' ? 65 : 160 });
  }
  window.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select') || event.target.isContentEditable) return;
    if ((event.code === 'KeyP' || event.code === 'Escape') && !event.repeat) {
      if (ui.phase === 'playing' || ui.phase === 'waiting') { event.preventDefault(); togglePause(); } return;
    }
    if (!keys[event.code] || ui.phase !== 'playing' || ui.paused) return;
    if (event.target.closest('button')) return;
    event.preventDefault(); if (!event.repeat) press(event.code, keys[event.code]);
  });
  window.addEventListener('keyup', event => held.delete(event.code));
  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault(); button.setPointerCapture(event.pointerId); button.classList.add('pressed');
      press(`touch:${event.pointerId}`, button.dataset.action);
    });
    const release = event => { held.delete(`touch:${event.pointerId}`); button.classList.remove('pressed'); };
    button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
    // 键盘或辅助技术激活虚拟按键时，click 的 detail 为 0。
    button.addEventListener('click', event => { if (event.detail === 0) dispatch(button.dataset.action); });
    button.addEventListener('contextmenu', event => event.preventDefault());
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) togglePause(true);
    else if (ui.mode === 'online' && net.joined) requestResync();
  });
  window.addEventListener('blur', () => togglePause(true));
  window.addEventListener('resize', () => { staticDirty = true; });
  // 模态框焦点不越界；Esc 在游戏里暂停，不会意外退出本局。
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const modal = ui.phase === 'menu' ? $('menu-layer') : ui.phase === 'result' ? $('result-layer') : null;
    if (!modal) return;
    const items = [...modal.querySelectorAll('button,input')].filter(el => !el.disabled);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  $('start-form').addEventListener('submit', event => { event.preventDefault(); joinOnline(); });
  $('solo-button').addEventListener('click', () => start(false));
  $('demo-button').addEventListener('click', () => start(true));
  $('room-input').addEventListener('input', () => {
    $('room-input').value = $('room-input').value.replace(/\D/g, '').slice(0, 4);
    $('room-input').removeAttribute('aria-invalid'); $('room-note').classList.remove('error');
    write('room-note', '第一位玩家创建房间，第二位加入即开始。');
  });
  $('pause-button').addEventListener('click', () => togglePause());
  $('resume-button').addEventListener('click', () => togglePause());
  $('menu-button').addEventListener('click', () => {
    if (ui.mode === 'online') {
      if (net.room?.status === 'playing' && !window.confirm('退出将视为认输，确定离开本局吗？')) return;
      leaveOnline();
    } else returnToMenu();
  });
  $('retry-button').addEventListener('click', () => {
    if (ui.mode !== 'online') { start(ui.demo); return; }
    if (!net.socket?.connected || !net.joined) return;
    $('retry-button').disabled = true;
    net.socket.timeout(4000).emit('game:rematch', {}, (error, result) => {
      if (ui.mode !== 'online') return;
      if (error || !result?.ok) { $('retry-button').disabled = false; write('rematch-note', result?.message || '请求超时，请重试'); }
    });
  });
  $('result-menu-button').addEventListener('click', () => { if (ui.mode === 'online') leaveOnline(); else returnToMenu(); });
  $('invite-button').addEventListener('click', async () => {
    if (!net.auth) return;
    const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('room', net.auth.roomId);
    // 凭证永远不进入邀请链接；localhost 链接不能发给另一台设备。
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
      write('game-hint', `房间 ${net.auth.roomId}：请朋友打开本机局域网 IP 或部署网址，再输入房间号。`); return;
    }
    try { await navigator.clipboard.writeText(url.href); write('game-hint', '邀请链接已复制，发给朋友即可。'); }
    catch { window.prompt('复制邀请链接并发给朋友', url.href); }
    document.activeElement?.blur();
  });
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-button').setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#171b27' : '#f3f4f6';
    updatePalette(); staticDirty = true;
  }
  $('theme-button').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(theme); try { localStorage.setItem('jelly-theme', theme); } catch { /* 隐私模式不影响游戏。 */ }
  });
  let savedTheme;
  try { savedTheme = localStorage.getItem('jelly-theme'); } catch { /* 存储不可用时使用浅色。 */ }
  setTheme(savedTheme === 'dark' ? 'dark' : 'light');
  document.querySelector('.shell').inert = true;
  document.querySelector('.touch-controls').inert = true;
  $('room-input').focus();

  const invitedRoom = new URLSearchParams(location.search).get('room');
  if (/^\d{4}$/.test(invitedRoom || '')) $('room-input').value = invitedRoom;
  try {
    const auth = JSON.parse(sessionStorage.getItem(AUTH_KEY));
    if (auth && /^\d{4}$/.test(auth.roomId) && /^[a-f0-9]{64}$/.test(auth.resumeToken)) joinOnline(auth);
  } catch { /* 无有效保存身份，正常进入主菜单。 */ }

  function frame(timestamp) {
    const dt = frameAt === null ? 0 : Math.min(100, Math.max(0, timestamp - frameAt));
    frameAt = timestamp;
    if (!ui.paused) {
      if (ui.phase === 'waiting' && ui.mode === 'solo') { ui.countdown -= dt; if (ui.countdown <= 0) setPhase('playing'); }
      else if (ui.phase === 'playing') {
        for (const state of held.values()) {
          state.elapsed += dt;
          while (state.elapsed >= state.next) { dispatch(state.action); state.next += state.action === 'softDrop' ? 55 : 70; }
        }
        if (ui.mode === 'solo') {
          game.update(dt, reducedMotion.matches);
          if (game.over) setPhase('result');
        }
      }
    }
    if (ui.mode === 'online') updateNetwork(timestamp, dt);
    refreshHud(); render(); requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
