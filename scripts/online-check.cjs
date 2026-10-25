'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createGameServer } = require('../server');

(async () => {
  const service = createGameServer({ reconnectMs: 6000 });
  let browser;
  const errors = [];
  const output = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  try {
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${service.server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    async function pageFor(mobile = false) {
      const context = await browser.newContext(mobile
        ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
        : { viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      // 仅在测试响应中注入观察器；生产文件没有外露的调试或改分接口。
      await page.route('**/game.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace("  const AUTH_KEY =", `  window.qa = {
          state: () => structuredClone({ phase: ui.phase, syncing: net.syncing, joined: net.joined,
            players: [...net.model.players.values()], pending: net.model.pending, matchId: net.model.matchId,
            selfId: net.model.selfId, board: game.board, eventSeq: net.model.eventSeq }),
          resync: () => requestResync(), socket: () => net.socket,
        };\n  const AUTH_KEY =`);
        await route.fulfill({ response, body });
      });
      await page.goto(url); return { page, context };
    }
    const { page: a } = await pageFor();
    const { page: b, context: bContext } = await pageFor(true);
    const { page: c } = await pageFor();
    const join = async (page, roomId = '4321') => {
      await page.locator('#room-input').fill(roomId); await page.locator('#start-form button').click();
    };
    const playing = page => page.waitForFunction(() => document.getElementById('phase-label').textContent === '双人对战');
    const synced = page => page.waitForFunction(() => window.qa.state().joined && !window.qa.state().syncing && window.qa.state().pending.length === 0);
    await join(a);
    await a.waitForFunction(() => document.getElementById('phase-label').textContent === '等待朋友加入');
    await join(b); await Promise.all([playing(a), playing(b)]);
    const room = service.rooms.get('4321'), [pa, pb] = room.players;
    await join(c);
    await c.waitForFunction(() => document.getElementById('room-note').textContent === '房间已满');
    await a.waitForFunction(() => document.getElementById('latency').textContent.includes('ms'));
    // 键盘与手机触控各自真实发送指令，验证对手与服务端棋盘一致。
    await a.locator('#board-canvas').click(); await a.keyboard.press('ArrowLeft'); await a.keyboard.press('Space');
    await b.locator('[data-action="right"]').tap(); await b.locator('[data-action="hardDrop"]').tap();
    await Promise.all([synced(a), synced(b)]);
    async function assertBoards() {
      for (const page of [a, b]) {
        await synced(page);
        const state = await page.evaluate(() => window.qa.state());
        for (const p of room.players) assert.deepEqual(state.players.find(x => x.playerId === p.id).board, p.board);
      }
    }
    await assertBoards();
    await a.screenshot({ path: path.join(output, 'online-desktop.png'), fullPage: true });
    await b.screenshot({ path: path.join(output, 'online-mobile.png'), fullPage: true });

    // 将服务端置于可重复的消行场景，经真实快照加载到前端，再执行硬降。
    const resetBoard = p => {
      p.board = Array.from({ length: 22 }, () => Array(10).fill(0));
      p.garbageRows = Array(22).fill(false); p.pendingGarbage = []; p.fallElapsed = 0;
    };
    resetBoard(pa); resetBoard(pb);
    pa.board[21] = [1,1,1,0,0,0,0,1,1,1];
    pa.activePiece = { type: 'I', rotation: 0, x: 3, y: 0 };
    await Promise.all([a.evaluate(() => window.qa.resync()), b.evaluate(() => window.qa.resync())]);
    await Promise.all([synced(a), synced(b)]);
    await a.locator('#board-canvas').click(); await a.keyboard.press('Space');
    await a.waitForFunction(() => document.getElementById('lines').textContent === '1');
    assert.equal(pb.pendingGarbage.length, 1);
    await b.locator('[data-action="hardDrop"]').tap();
    await Promise.all([synced(a), synced(b)]); await assertBoards();
    assert.equal(pb.garbageRows.filter(Boolean).length, 1);

    const oldId = pb.id, before = JSON.stringify(pb.board);
    await b.reload(); await playing(b); await synced(b);
    assert.equal(room.players[1].id, oldId); assert.equal(JSON.stringify(pb.board), before);
    await assertBoards();

    // 强制传输中断并断网，验证自动重连，而非手工再次加入。
    await bContext.setOffline(true);
    service.io.sockets.sockets.get(pb.socketId)?.conn.close();
    await a.waitForFunction(() => document.getElementById('phase-label').textContent === '对手掉线，等待重连');
    const pausedBoard = JSON.stringify(pa.board), pausedY = pa.activePiece.y;
    await a.keyboard.press('Space'); await a.waitForTimeout(250);
    assert.equal(JSON.stringify(pa.board), pausedBoard); assert.equal(pa.activePiece.y, pausedY);
    await bContext.setOffline(false);
    await Promise.all([playing(a), playing(b)]); await assertBoards();
    await b.locator('[data-action="hardDrop"]').tap(); await synced(b);
    assert.ok(pb.lastInputSeq > 0);

    // 缺失事件会暂停输入并取快照；重新校准后仍能操作。
    await a.evaluate(() => {
      const socket = window.qa.socket(), listener = socket.listeners('game:event')[0];
      socket.off('game:event', listener);
      socket.once('game:event', () => socket.on('game:event', listener));
    });
    await a.waitForTimeout(1100); await synced(a); await assertBoards();

    // 堆顶结束，两边分别看到胜/负；双方同意后新一局序号归零。
    pa.board[0][0] = 1;
    await a.evaluate(() => window.qa.resync()); await synced(a);
    await a.locator('#board-canvas').click(); await a.keyboard.press('Space');
    await Promise.all([a.locator('#result-layer').waitFor({ state: 'visible' }), b.locator('#result-layer').waitFor({ state: 'visible' })]);
    assert.equal(await b.locator('#result-title').textContent(), '你赢了！');
    const firstMatch = room.matchId;
    await a.locator('#retry-button').click();
    await a.waitForFunction(() => document.getElementById('retry-button').textContent.includes('等待对手'));
    await b.locator('#retry-button').tap();
    await Promise.all([playing(a), playing(b)]);
    assert.notEqual(room.matchId, firstMatch); assert.equal(pa.lastInputSeq, 0); assert.equal(pb.lastInputSeq, 0);
    assert.equal(pa.board.flat().some(Boolean), false);

    // 对手超时后胜利；重连只能看结束状态，不能复活上一局。
    await bContext.setOffline(true); service.io.sockets.sockets.get(pb.socketId)?.conn.close();
    await a.locator('#result-layer').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await a.locator('#result-title').textContent(), '你赢了！');
    await bContext.setOffline(false);
    await b.locator('#result-layer').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(room.status, 'finished');
    await a.screenshot({ path: path.join(output, 'online-result.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('联机浏览器验收通过：PC + 手机、满员、RTT、双方状态、攻击垃圾、刷新恢复、自动重连、事件缺口修复、胜负、重赛、超时判负。');
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
