'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LocalGame, NetworkState, cells, createSocketCommandSender } = require('../public/game');

test('本地七袋出块：每连续七个包含全部七种方块', () => {
  const game = new LocalGame();
  const pieces = [game.active.type];
  for (let i = 1; i < 21; i++) { game.spawn(); pieces.push(game.active.type); }
  for (let i = 0; i < 21; i += 7) assert.equal(new Set(pieces.slice(i, i + 7)).size, 7);
});

test('时间戳增量驱动重力，不足 800ms 不落格，累计达到后下落', () => {
  const game = new LocalGame();
  const startY = game.active.y;
  game.update(799); assert.equal(game.active.y, startY);
  game.update(1); assert.equal(game.active.y, startY + 1);
  game.update(1600); assert.equal(game.active.y, startY + 3);
  assert.equal(game.elapsed, 2400);
});

test('边界碰撞与右侧踢墙不会让方块进入墙内', () => {
  const game = new LocalGame();
  game.active = { type: 'I', rotation: 1, x: 7, y: 4 };
  game.command('right'); assert.equal(game.active.x, 7);
  game.command('rotateCW'); assert.equal(game.active.rotation, 2);
  assert.ok(cells(game.active).every(p => p.x >= 0 && p.x < 10));
  for (let i = 0; i < 20; i++) game.command('left');
  assert.equal(Math.min(...cells(game.active).map(p => p.x)), 0);
});

test('硬降落点与投影一致，只锁定四格并产生一个新方块', () => {
  const game = new LocalGame();
  const previous = { ...game.active }, ghost = game.ghost();
  assert.deepEqual(game.active, previous);
  game.command('hardDrop');
  assert.equal(game.board.flat().filter(Boolean).length, 4);
  for (const { x, y } of cells(ghost)) assert.notEqual(game.board[y][x], 0);
  assert.equal(game.active.y, 0);
});

test('四行消除立即结算，独立动画结束后显示挑战成功', () => {
  const game = new LocalGame(); game.reset(true);
  game.command('hardDrop');
  assert.equal(game.score, 800); assert.equal(game.lines, 4);
  assert.equal(game.clearAnimation.rows.length, 4);
  assert.equal(game.board.flat().some(Boolean), false);
  assert.equal(game.command('hardDrop'), false);
  game.update(180); assert.equal(game.over, false);
  game.update(180); assert.equal(game.over, true); assert.equal(game.won, true);
  assert.equal(game.clearAnimation, null);
});

test('减少动态效果时缩短消行动画，不改变计分和胜负', () => {
  const game = new LocalGame(); game.reset(true); game.command('hardDrop');
  game.update(80, true); assert.equal(game.over, true); assert.equal(game.score, 800);
});

test('生成位置被堵塞则判负，不覆盖已有方块', () => {
  const game = new LocalGame(); game.queue[0] = 'O'; game.board[0][4] = 7;
  game.spawn(); assert.equal(game.over, true); assert.equal(game.won, false);
  assert.equal(game.command('hardDrop'), false); assert.equal(game.board[0][4], 7);
});

test('联机发送适配器不缓存离线指令，在线按服务端协议 emit', () => {
  const calls = [], callback = () => {};
  const socket = { connected: false, emit: (...args) => calls.push(args) };
  const send = createSocketCommandSender(socket, callback);
  assert.equal(send({ seq: 1, action: 'left' }), false); assert.equal(calls.length, 0);
  socket.connected = true;
  assert.equal(send({ seq: 1, action: 'left' }), true);
  assert.deepEqual(calls[0], ['game:command', { seq: 1, action: 'left' }, callback]);
});

function networkFixture() {
  const game = new LocalGame();
  const p = { playerId: 'a', board: game.board, activePiece: game.active, nextQueue: game.queue,
    garbageRows: Array(22).fill(false), pendingGarbage: [], lastInputSeq: 0, score: 0, lines: 0, gameOver: false };
  const snapshot = { selfId: 'a', matchId: 'match1', eventSeq: 0, players: [p, { ...structuredClone(p), playerId: 'b' }] };
  const model = new NetworkState(); model.snapshot(snapshot);
  return { model, game, snapshot };
}
test('联机预测不修改权威棋盘，确认硬降后不重复锁定', () => {
  const { model, game } = networkFixture();
  const piece = { ...game.active }, ghost = game.ghost();
  model.pending = [{ seq: 1, action: 'hardDrop' }]; model.predict(game);
  assert.equal(game.board.flat().filter(Boolean).length, 4);
  assert.equal(model.players.get('a').board.flat().filter(Boolean).length, 0);
  assert.equal(game.active, null);
  const update = { matchId: 'match1', eventSeq: 1, playerId: 'a', inputSeq: 1, operations: [
    { type: 'lock', playerId: 'a', cells: cells(ghost), value: 1 },
    { type: 'spawn', playerId: 'a', activePiece: piece, nextQueue: ['I'] },
  ] };
  model.apply(update); model.predict(game);
  assert.equal(model.pending.length, 0); assert.equal(game.board.flat().filter(Boolean).length, 4);
  assert.equal(model.apply(update), 'old');
});
test('事件缺口与旧比赛不会推进棋盘；快照保留仍在途指令且不重用序号', () => {
  const { model, snapshot } = networkFixture();
  assert.equal(model.apply({ matchId: 'match1', eventSeq: 3 }), 'gap');
  assert.equal(model.apply({ matchId: 'old', eventSeq: 1 }), 'old');
  assert.equal(model.eventSeq, 0);
  model.pending = [{ seq: 1, action: 'left' }, { seq: 2, action: 'right' }];
  snapshot.players[0].lastInputSeq = 1;
  model.snapshot(snapshot, true);
  assert.equal(model.pending.length, 1); assert.equal(model.seq, 2);
  model.snapshot(snapshot, false); assert.equal(model.pending.length, 0); assert.equal(model.seq, 1);
});
test('客户端按顺序应用垃圾入场、消行、底部抵消与队列抵消', () => {
  const { model } = networkFixture();
  const operations = [
    { type: 'garbage:queue', playerId: 'b', rows: [{ holes: [3] }, { holes: [1, 8] }] },
    { type: 'garbage:insert', playerId: 'b', rows: [{ holes: [3] }, { holes: [1, 8] }] },
    { type: 'garbage:remove', playerId: 'b', rows: [21] },
    { type: 'garbage:queue', playerId: 'b', rows: [{ holes: [0] }] },
    { type: 'garbage:cancel', playerId: 'b', count: 1 },
  ];
  model.apply({ matchId: 'match1', eventSeq: 1, playerId: 'a', inputSeq: 1, operations });
  const b = model.players.get('b');
  assert.deepEqual(b.board[21], [8,8,8,0,8,8,8,8,8,8]);
  assert.equal(b.garbageRows.filter(Boolean).length, 1); assert.equal(b.pendingGarbage.length, 0);
  const animations = model.apply({ matchId: 'match1', eventSeq: 2, playerId: 'b', inputSeq: 1, operations: [
    { type: 'lock', playerId: 'b', cells: [{ x: 3, y: 21 }], value: 1 },
    { type: 'clear', playerId: 'b', rows: [21], lines: 1, score: 100 },
  ] });
  assert.equal(animations.length, 1); assert.ok(animations[0].before[21].every(Boolean));
  assert.equal(b.board.flat().some(Boolean), false); assert.equal(b.score, 100);
});
