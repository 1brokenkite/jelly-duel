'use strict';

// 使用真正的 Socket.io 连接测试协议；棋盘夹具仅通过服务端测试实例设置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`等待 ${name} 超时`)); }, 2000);
    function listener(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, listener);
  });
}
function request(socket, name, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(2000).emit(name, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}
async function setup(t, options = {}) {
  const instance = createGameServer(options);
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await instance.close(); });
  async function client() {
    const socket = connect(`http://127.0.0.1:${instance.server.address().port}`, {
      transports: ['websocket'], reconnection: false, forceNew: true,
    });
    clients.push(socket);
    await event(socket, 'connect');
    return socket;
  }
  async function pair(roomId = '0123') {
    const a = await client();
    const b = await client();
    const authA = await request(a, 'room:join', { roomId });
    const started = event(a, 'game:start');
    const authB = await request(b, 'room:join', { roomId });
    const snapshot = await started;
    return { a, b, authA, authB, snapshot, room: instance.rooms.get(roomId) };
  }
  return { ...instance, client, pair };
}

test('4 位房间号、两人开局、第三人拒绝、快照不泄露凭证', async t => {
  const service = await setup(t);
  const invalid = await service.client();
  assert.equal((await request(invalid, 'room:join', { roomId: '123' })).code, 'INVALID_ROOM');
  assert.equal((await request(invalid, 'room:join', { roomId: { toString: null } })).code, 'INVALID_ROOM');
  const { snapshot, room } = await service.pair();
  assert.equal(room.status, 'playing');
  assert.equal(snapshot.players.length, 2);
  assert.deepEqual(snapshot.players[0].activePiece, snapshot.players[1].activePiece);
  assert.deepEqual(snapshot.players[0].nextQueue, snapshot.players[1].nextQueue);
  assert.equal(JSON.stringify(snapshot).includes('resumeToken'), false);
  assert.equal((await request(invalid, 'room:join', { roomId: '0123' })).code, 'ROOM_FULL');
});

test('服务端验证指令，拒绝伪造消行，硬降重传仅执行一次', async t => {
  const service = await setup(t);
  const { a, b, room } = await service.pair();
  assert.equal((await request(a, 'game:command', { seq: 1, action: 'clear', lines: 4 })).code, 'INVALID_COMMAND');
  assert.equal((await request(a, 'game:command', { seq: 2, action: 'hardDrop' })).code, 'SEQ_GAP');
  const received = event(b, 'game:event');
  assert.equal((await request(a, 'game:command', { seq: 1, action: 'hardDrop', lines: 4 })).ok, true);
  const update = await received;
  assert.equal(update.action, 'hardDrop');
  assert.equal('board' in update, false);
  assert.equal(update.operations.filter(op => op.type === 'lock').length, 1);
  const before = JSON.stringify(room.players[0].board);
  const index = room.players[0].pieceIndex;
  assert.equal((await request(a, 'game:command', { seq: 1, action: 'hardDrop' })).duplicate, true);
  assert.equal(JSON.stringify(room.players[0].board), before);
  assert.equal(room.players[0].pieceIndex, index);
  assert.equal(room.players[0].lines, 0);
});

// 横向 I 块补齐底行，保证一次合法硬降只消除一行。
function prepareClear(player) {
  player.board = Array.from({ length: 22 }, () => Array(10).fill(0));
  player.garbageRows = Array(22).fill(false);
  player.board[21] = [1, 1, 1, 0, 0, 0, 0, 1, 1, 1];
  player.activePiece = { type: 'I', rotation: 0, x: 3, y: 0 };
}

test('消 N 行发送 N 行垃圾，每行 1～2 个不同空洞，双方消行抵消待入场攻击', async t => {
  const service = await setup(t);
  const { a, b, room } = await service.pair();
  const [pa, pb] = room.players;
  prepareClear(pa);
  await request(a, 'game:command', { seq: 1, action: 'hardDrop' });
  assert.equal(pa.lines, 1);
  assert.equal(pb.pendingGarbage.length, 1);
  const holes = pb.pendingGarbage[0].holes;
  assert.ok(holes.length === 1 || holes.length === 2);
  assert.equal(new Set(holes).size, holes.length);
  assert.ok(holes.every(x => x >= 0 && x < 10));
  prepareClear(pb);
  await request(b, 'game:command', { seq: 1, action: 'hardDrop' });
  assert.equal(pb.pendingGarbage.length, 0);
  assert.equal(pa.pendingGarbage.length, 0);
  assert.equal(pb.garbageRows.some(Boolean), false);
});

test('两行消除发送两行攻击；已有底部垃圾行优先抵消', async t => {
  const service = await setup(t);
  const { a, b, room } = await service.pair();
  const [pa, pb] = room.players;
  for (const y of [20, 21]) pa.board[y] = [1, 1, 1, 1, 0, 0, 1, 1, 1, 1];
  pa.activePiece = { type: 'O', rotation: 0, x: 4, y: 0 };
  await request(a, 'game:command', { seq: 1, action: 'hardDrop' });
  assert.equal(pa.lines, 2);
  assert.equal(pb.pendingGarbage.length, 2);

  prepareClear(pb);
  pb.board[20] = [...pb.board[21]];
  pb.board[21] = [8, 8, 8, 8, 0, 8, 8, 8, 8, 8];
  pb.garbageRows[21] = true;
  const received = event(a, 'game:event');
  await request(b, 'game:command', { seq: 1, action: 'hardDrop' });
  const update = await received;
  assert.ok(update.operations.some(op => op.type === 'garbage:remove'));
  assert.equal(update.operations.some(op => op.type === 'garbage:cancel'), false);
  assert.equal(pb.garbageRows.filter(Boolean).length, 2); // 原垃圾行移除，积压两行入场。
  assert.equal(pa.pendingGarbage.length, 0);
});

test('垃圾行抬升顶部时判负，不丢弃顶部方块后继续游戏', async t => {
  const service = await setup(t);
  const { a, room, authB } = await service.pair();
  const pa = room.players[0];
  pa.board[0][0] = 1;
  pa.pendingGarbage.push({ holes: [5] });
  const over = event(a, 'game:over');
  await request(a, 'game:command', { seq: 1, action: 'hardDrop' });
  assert.equal((await over).winnerId, authB.playerId);
  assert.equal(room.status, 'finished');
});

test('掉线暂停，凭证恢复棋盘及序号，伪造凭证不允许抢占', async t => {
  const service = await setup(t);
  const { a, b, authA, room } = await service.pair();
  await request(a, 'game:command', { seq: 1, action: 'hardDrop' });
  const board = JSON.stringify(room.players[0].board);
  const paused = event(b, 'room:state');
  a.disconnect();
  assert.equal((await paused).status, 'paused');
  assert.equal((await request(b, 'game:command', { seq: 1, action: 'left' })).code, 'NOT_PLAYING');
  const attacker = await service.client();
  assert.equal((await request(attacker, 'room:join', { roomId: '0123', resumeToken: 'a'.repeat(64) })).code, 'RESUME_FAILED');
  const resumed = await service.client();
  const restored = event(resumed, 'game:snapshot');
  assert.equal((await request(resumed, 'room:join', { roomId: '0123', resumeToken: authA.resumeToken })).ok, true);
  const snapshot = await restored;
  assert.equal(snapshot.status, 'playing');
  const self = snapshot.players.find(p => p.playerId === authA.playerId);
  assert.equal(JSON.stringify(self.board), board);
  assert.equal(self.lastInputSeq, 1);
  assert.equal((await request(resumed, 'game:command', { seq: 2, action: 'left' })).ok, true);
});

test('刷新时新连接替换旧连接，不触发错误暂停', async t => {
  const service = await setup(t);
  const { a, authA, room } = await service.pair();
  const newA = await service.client();
  const disconnected = event(a, 'disconnect');
  await request(newA, 'room:join', { roomId: '0123', resumeToken: authA.resumeToken });
  await disconnected;
  assert.equal(room.status, 'playing');
  assert.equal(room.players[0].socketId, newA.id);
  assert.equal(room.players[0].connected, true);
});

test('重连超时判负，超时后恢复只能查看结束状态', async t => {
  const service = await setup(t, { reconnectMs: 120 });
  const { a, b, authA, authB } = await service.pair();
  const over = event(b, 'game:over');
  a.disconnect();
  const result = await over;
  assert.equal(result.reason, 'reconnect_timeout');
  assert.equal(result.winnerId, authB.playerId);
  const resumed = await service.client();
  const restored = event(resumed, 'game:snapshot');
  await request(resumed, 'room:join', { roomId: '0123', resumeToken: authA.resumeToken });
  assert.equal((await restored).status, 'finished');
});

test('服务端自动重力广播增量事件', async t => {
  const service = await setup(t);
  const { a, room } = await service.pair();
  const before = room.players[0].activePiece.y;
  const update = await event(a, 'game:event');
  assert.equal(update.action, 'gravity');
  assert.equal(update.operations[0].activePiece.y, before + 1);
});

test('主动退出认输，结束后双方同意重赛，身份不变且序号重置', async t => {
  const service = await setup(t);
  const { a, b, room, authA, authB } = await service.pair();
  const beforeMatch = room.matchId;
  // 合法触发堆顶，让两个连接都留在房间里再申请重赛。
  room.players[0].board[0][0] = 1;
  const over = event(b, 'game:over');
  await request(a, 'game:command', { seq: 1, action: 'hardDrop' }); await over;
  await request(a, 'game:rematch', {});
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.rematchReady, [authA.playerId]);
  const started = event(a, 'game:start');
  await request(b, 'game:rematch', {}); const snapshot = await started;
  assert.notEqual(snapshot.matchId, beforeMatch); assert.equal(room.eventSeq, 0);
  assert.equal(room.players[0].lastInputSeq, 0); assert.equal(room.players[0].id, authA.playerId);
  assert.equal(room.players[0].resumeToken, authA.resumeToken);
  assert.equal(room.players[0].board.flat().some(Boolean), false);
  const surrendered = event(b, 'game:over');
  await request(a, 'room:leave', {});
  const result = await surrendered;
  assert.equal(result.winnerId, authB.playerId); assert.equal(result.reason, 'surrender');
  assert.equal((await request(b, 'game:rematch', {})).code, 'OPPONENT_OFFLINE');
  const replacement = await service.client();
  assert.equal((await request(replacement, 'room:join', { roomId: '0123', resumeToken: authA.resumeToken })).code, 'RESUME_FAILED');
});

test('等待时离开释放房间，RTT 心跳返回服务端时间', async t => {
  const service = await setup(t); const a = await service.client();
  await request(a, 'room:join', { roomId: '0999' });
  const ping = await request(a, 'net:ping', {});
  assert.equal(ping.ok, true); assert.ok(Number.isSafeInteger(ping.serverTime));
  await request(a, 'room:leave', {}); assert.equal(service.rooms.has('0999'), false);
  assert.equal((await request(a, 'room:join', { roomId: '0999' })).ok, true);
});
