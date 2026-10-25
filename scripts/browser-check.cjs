'use strict';
// 使用本机 Chrome 验收，不下载浏览器，不访问外部页面。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createGameServer } = require('../server');

(async () => {
  const service = createGameServer();
  let browser;
  const errors = [];
  const output = process.env.QA_OUTPUT_DIR || path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  try {
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${service.server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto(url);
    await page.screenshot({ path: path.join(output, 'desktop-menu.png'), fullPage: true });
    await page.locator('#room-input').fill('12');
    await page.locator('#start-form button').click();
    assert.equal(await page.locator('#room-input').getAttribute('aria-invalid'), 'true');
    await page.locator('#room-input').fill('0123');
    await page.locator('#demo-button').click();
    assert.equal(await page.locator('#phase-label').textContent(), '单人准备中');
    // 倒计时也应能暂停，暂停画面不能被下一帧的数字覆盖。
    await page.keyboard.press('p');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#cover-title').textContent(), '休息一下');
    await page.locator('#resume-button').click();
    await page.waitForFunction(() => document.getElementById('phase-label').textContent === '单人练习', undefined, { timeout: 6000 });
    await page.screenshot({ path: path.join(output, 'desktop-playing.png'), fullPage: true });
    assert.equal(await page.locator('#room-tag').textContent(), '预留房间 0123');
    await page.keyboard.press('Space');
    await page.waitForTimeout(130);
    await page.screenshot({ path: path.join(output, 'clear-animation.png'), fullPage: true });
    await page.locator('#result-layer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#result-title').textContent(), '挑战成功！');
    assert.equal(await page.locator('#result-score').textContent(), '800');
    await page.screenshot({ path: path.join(output, 'desktop-result.png'), fullPage: true });
    await page.locator('#result-menu-button').click();
    await page.locator('#solo-button').click();
    await page.waitForFunction(() => document.getElementById('phase-label').textContent === '单人练习');
    await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(300); await page.keyboard.up('ArrowLeft');
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
    await page.locator('#pause-button').click();
    const pausedBoard = await page.locator('#board-canvas').evaluate(canvas => canvas.toDataURL());
    await page.waitForTimeout(950);
    assert.equal(await page.locator('#board-canvas').evaluate(canvas => canvas.toDataURL()), pausedBoard);
    await page.locator('#resume-button').click();
    await page.locator('#theme-button').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.screenshot({ path: path.join(output, 'desktop-dark.png'), fullPage: true });
    // 连续中央硬降触发真实堆顶，验证失败结算也能正常显示。
    await page.locator('#board-canvas').click();
    for (let i = 0; i < 25 && await page.locator('#result-layer').isHidden(); i++) {
      await page.keyboard.press('Space'); await page.waitForTimeout(35);
    }
    await page.locator('#result-layer').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#result-copy').textContent()).includes('挑战失败'));
    assert.ok(requests.every(request => request.startsWith(url)), '页面不得请求外部服务');
    assert.equal(requests.some(request => request.includes('/socket.io/?')), false, '单人阶段不应创建联机连接');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const phone = await mobile.newPage();
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(url);
    await phone.locator('#demo-button').tap();
    await phone.waitForFunction(() => document.getElementById('phase-label').textContent === '单人练习');
    assert.equal(await phone.locator('.touch-controls').isVisible(), true);
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await phone.screenshot({ path: path.join(output, 'mobile-playing.png'), fullPage: true });
    await phone.locator('[data-action="hardDrop"]').tap();
    await phone.locator('#result-layer').waitFor({ state: 'visible' });
    assert.equal(await phone.locator('#result-score').textContent(), '800');
    await phone.locator('#result-menu-button').tap();
    await phone.setViewportSize({ width: 320, height: 740 });
    await phone.locator('#solo-button').tap();
    await phone.waitForFunction(() => document.getElementById('phase-label').textContent === '单人练习');
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await phone.screenshot({ path: path.join(output, 'mobile-small.png'), fullPage: true });
    await phone.setViewportSize({ width: 390, height: 667 });
    await phone.waitForTimeout(150);
    const boardBox = await phone.locator('#board-canvas').boundingBox();
    const controlsBox = await phone.locator('.touch-controls').boundingBox();
    assert.ok(boardBox.y + boardBox.height < controlsBox.y, '短屏手机的按键不能遮住棋盘底部');
    await phone.screenshot({ path: path.join(output, 'mobile-short.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('浏览器验收通过：桌面、390px/320px 手机、倒计时、键盘/触控硬降、消行动画、暂停、结算、暗色模式、无外部请求。');
    console.log(`截图位置：${output}`);
  } finally {
    if (browser) await browser.close();
    await service.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
