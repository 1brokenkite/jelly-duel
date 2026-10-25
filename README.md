# 双人俄罗斯方块：电脑与手机实时对战

已实现 Node.js + Express + Socket.io 后端，以及原生 HTML/CSS/Canvas 的双人对战与单人练习页面。
支持房间匹配、服务端权威模拟、本地预测、增量同步、垃圾行、30 秒重连、刷新恢复和双方同意重赛。
所有运行时连接均为浏览器与自己的服务器直连，无 Firebase、Google Cloud 或 CDN。

## 运行

安装 Node.js 20 或更高版本，在项目文件夹打开终端：

```powershell
npm install --registry=https://registry.npmmirror.com
npm start
```

出现 `俄罗斯方块服务已启动：http://localhost:3000` 即表示成功。
访问 http://localhost:3000/health 应显示 `{"ok":true}`。
在这台电脑上访问 http://127.0.0.1:3000/ 即可试玩。
双方输入相同的 4 位房间号，点击“进入双人房间”，第二人加入即开局。
也可点击“单人练习”，3 秒倒计时后开始。手机访问和云部署见 [DEPLOY.md](DEPLOY.md)。
点击“体验消行动画”，随后按空格或底部“硬降”，可以直接查看四行消除和成功结算。

```powershell
npm test
```

测试使用真实 Socket.io 客户端连接临时本地端口，检查房间、消行攻击、重连和超时等逻辑。

## 前端与验证

- `public/index.html`：双战区、明暗主题、响应式触屏布局、菜单和结算弹窗。
- `public/game.js`：单人规则、权威状态副本、预测重放、Socket.io 生命周期、Canvas 果冻绘制。
- 键盘：左右移动、上键旋转、下键加速、空格硬降。P/Esc 仅用于单人暂停。
- 触屏：移动和加速可长按，多指按下/松开分别处理；窄屏显示对手实时缩影。
- 联机状态：主菜单 → 匹配等待 → 双人对战 → 胜负结算；掉线时双方统一暂停。
- 前端使用 requestAnimationFrame 处理单人下落、长按、计时和动画，没有 setInterval。
- 联机重力来自服务端；本地只预测操作，收到确认后重建并重放尚未确认的输入。
- 一次硬降确认前不预测随机下一块。消行攻击、胜负以及垃圾洞位置均由服务端确定。
- 正常只广播操作增量；初次进入、刷新恢复或检测到事件缺口时才取全量快照。
- 本人重连时丢弃旧操作；对手重连导致的快照保留本方尚在途的指令，不重复使用输入序号。
- `sessionStorage` 按标签页保存恢复凭证；邀请链接只带房间号，不带身份凭证。
- 退出正在进行的对局视为认输；结束后双方点击“再来一局”开启新比赛，保留身份、重置棋盘和序号。
- 自由练习固定每 800ms 下落一格、等级 1；联机的权威重力采用相同速度。
- RTT 每 3 秒测量一次，是请求/响应往返时间，不是单程延迟。

```powershell
npm test
npm run test:ui
npm run test:online
```

后两项使用本机已安装的 Chrome；截图保存在 `artifacts/`（已加入 .gitignore）。
联机验收使用桌面与手机尺寸的独立浏览器会话，覆盖双方棋盘一致性、消行攻击、刷新恢复、自动重连、事件缺口修复、重赛和超时判负。
Playwright 仅为开发测试依赖，不随生产部署安装，游戏运行无外部 CDN 依赖。

## 前端协议

房间号是 **4 位数字字符串**，例如 `"0123"`，不要使用数字 `123`。
新玩家发送 `room:join`，第一个人创建房间并等待，第二个人加入后立即开局。
每个房间最多两人；掉线者等待重连时仍占据原席位。

```js
socket.emit('room:join', { roomId: '0123' }, result => {
  // result.ok === true 时保存 roomId、playerId、resumeToken。
  // resumeToken 是恢复自己棋盘的秘密凭证，不应交给对手。
});

// 重连、刷新后，在新 socket 连接的 connect 事件中重新加入：
socket.emit('room:join', { roomId: '0123', resumeToken: '首次加入返回的凭证' }, callback);

// 每位玩家有自己独立的连续序号，从 1 开始。
socket.emit('game:command', { seq: 1, action: 'left' }, callback);
socket.emit('game:command', { seq: 2, action: 'rotateCW' }, callback);
socket.emit('game:command', { seq: 3, action: 'hardDrop' }, callback);

// 出现序号缺口或画面不同步时，最多每秒请求一次完整快照。
socket.emit('game:resync', {}, callback);
```

合法 action：`left`、`right`、`rotateCW`、`rotateCCW`、`softDrop`、`hardDrop`。
消行、垃圾行、胜负只由服务端计算。客户端的 `clear` 指令会被拒绝。
操作碰墙时也是一条已处理的有效指令，序号仍递增；非法、暂停或限流拒绝的指令不消耗序号。
重发已处理序号返回 `duplicate: true`，不会重复落块。

| 服务端事件 | 前端处理 |
| --- | --- |
| `room:state` | 更新连接状态、暂停、重连截止时间、胜负信息 |
| `game:start` | 用完整快照初始化双方棋盘，开启操作 |
| `game:snapshot` | 覆盖本地权威状态；本人重连清理旧指令，对手重连时保留仍在途的本方指令 |
| `game:event` | 按 eventSeq 顺序应用 operations，再重放尚未确认的本地预测 |
| `game:over` | 用最终快照显示结果，停止操作 |
| `room:error` | 显示未使用确认回调时的错误信息 |
| `room:expired` | 清除房间凭证，重新连接并进入新房间 |

`game:event` 包含 `roomId`、`matchId`、`eventSeq`、`playerId`、`action`、`inputSeq`、`operations`、`serverTime`。
一条事件的 operations 必须按顺序全部执行，下面每条操作都带目标 `playerId`：

| operation.type | 含义 |
| --- | --- |
| `active` | 替换 activePiece；服务端已经验证碰撞或旋转 |
| `lock` | 将 cells 中的位置写入 value，并清空活动方块 |
| `clear` | 同时删除 rows 指定行、顶部补空行，更新 score 和 lines |
| `garbage:remove` | 同时删除指定垃圾行、顶部补空行，行标记随之移动 |
| `garbage:cancel` | 从待入场队列头部移除 count 行 |
| `garbage:queue` | 将 rows 追加到目标玩家的待入场垃圾行队列 |
| `garbage:insert` | 按顺序移除棋盘顶行并从底部插入垃圾行，然后清空待入场队列 |
| `spawn` | 设置新 activePiece 和 nextQueue，重置本方重力计时 |

每条垃圾行格式为 `{ holes: [列号, ...] }`，holes 有 1～2 个不同列号；其他列填 8。
删除多行应一次过滤后在顶部补空行，不要按升序逐行 splice，以免行号错位。
棋盘为 22 行 × 10 列，顶部 2 行隐藏，客户端绘制可见坐标时 y 减 2。
`garbageRows` 与棋盘每行一一对应，删除行、补空行、插入垃圾行时必须一起更新。

快照是历史落块计算后的完整当前棋盘，不必重放之前每一步操作。
`eventSeq` 属于整场比赛，`lastInputSeq` 属于单个玩家；二者不可混用。
忽略不匹配当前 matchId 的事件及 eventSeq 不大于已应用序号的旧事件。
若遇事件序号缺口，请求快照恢复；本地预测不要重复应用自己已确认的操作。

## 心跳、重连和暂停

服务端每 5 秒发起 Socket.io 心跳，5 秒未回应即视为断线。
**30 秒恢复窗口从服务端检测到 disconnect 的时刻开始计算。**
掉线后暂停双方重力与输入，通知对手“对手掉线，等待重连”。
窗口内使用同房间号与 resumeToken 恢复，双方收到快照后继续。
超时后在线者获胜，双方均离线时本局结束且没有胜者。
超时后持原凭证仍可在房间保留期内查看最终状态，但不能继续该局。

前端创建连接时启用：

```js
const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 2000,
  randomizationFactor: 0.5,
});
```

前端已在 connect 事件中读取已保存的 roomId/resumeToken 并发送 room:join。
首次进入时不要发送空字符串或 null 凭证，应省略 resumeToken 字段。
恢复失败应显示错误并让玩家选择新房间，不能静默当作新玩家占席。
掉线、暂停时立即禁用输入；恢复快照到达前不要重新启用输入。
不要离线 emit 游戏操作；在新 connect 中加入房间前清空旧的 socket.sendBuffer，
收到快照后也要清空应用层的预测/待发队列，避免重连后执行很久以前的方向键或硬降。
本版使用 sessionStorage 保存每个标签页自己的凭证，避免同一浏览器双标签页测试时互相顶号。
普通刷新也会保留 sessionStorage；跨标签页恢复则需要按产品设计使用 localStorage。

## 当前规则和部署范围

- 同一房间双方使用相同七袋出块序列，但下落进度独立。重力每 800ms 下落一格。
- 垃圾行先排队，在接收方下一次方块锁定、消行和抵消结算后入场。
- 消 N 行产生 N 点攻击：先从底部向上移除已有垃圾行，再抵消排队垃圾行，剩余攻击发送给对手。
  这是按本项目要求选择的规则，区别于仅抵消排队攻击的常见竞技规则。
- 垃圾行抬升导致顶部溢出、结算后隐藏区仍有方块、或新方块生成碰撞时判负。
- 简单踢墙；暂不包含完整 SRS、锁定延迟、暂存方块和账号系统。
- 空等房间 10 分钟清理，结束房间保留 5 分钟，重连不能重新激活已结束对局。
- 内存版只运行一个 Node.js 实例。支持玩家断线恢复，**服务器进程重启会丢失房间**。
  将来需要多实例或跨重启恢复时，再加入共享存储、状态持久化和实例路由。
- 默认同源托管；前后端分离时设置 FRONTEND_ORIGIN 为精确前端来源，包含协议和端口。
- 国内云部署可用 Nginx 代理 HTTPS/WSS；需转发 WebSocket Upgrade，代理超时应大于 10 秒，建议 60 秒。
- resumeToken 只验证席位归属，不是完整账号登录；权威模拟能拒绝伪造状态，但不负责检测自动操作脚本。

## 新增联机事件

- `net:ping {}`：确认回调返回 `{ ok, serverTime }`，用于测量 RTT。
- `room:leave {}`：等待时释放房间；对战中判认输并释放连接绑定，原恢复凭证作废。
- `game:rematch {}`：仅已结束且双方在线时可申请。两人都同意才启动新 matchId，棋盘和输入/事件序号归零。
- `room:state` 另带 `serverTime`、`elapsedMs`、`rematchReady`。快照玩家包含 reconnectDeadline，供倒计时显示。
