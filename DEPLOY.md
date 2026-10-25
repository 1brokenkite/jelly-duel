# 手机与电脑联机、部署上线

## 先在同一 Wi-Fi 下试玩

1. 电脑运行 `npm start`，保持进程运行。
2. 电脑打开 `http://127.0.0.1:3000/`。
3. 手机连接同一 Wi-Fi，打开 `http://电脑的局域网IP:3000/`。
4. 双方输入相同 4 位房间号，例如 `1234`，点击“进入双人房间”。第二人加入立即开局。

本次检查到电脑 WLAN 地址为 **192.168.10.140**，对应手机地址：
`http://192.168.10.140:3000/`。更换网络或路由器重新分配地址后可能变化，用 `ipconfig` 查看 WLAN IPv4。
`localhost`/`127.0.0.1` 只代表当前设备，不能把电脑的 localhost 地址发给手机。

如果手机无法连接，先确认同一 Wi-Fi、不是访客隔离网络；检查代理软件是否允许局域网直连。
Windows 若提示防火墙，允许 Node.js 在可信的专用网络上通信。
只有在确认防火墙阻止时，才需要管理员手动添加限定局域网的规则（本项目不会自动修改防火墙）：

```powershell
New-NetFirewallRule -DisplayName "Jelly Duel LAN 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private -Action Allow
```

同一电脑验收可用两个不同浏览器或正常/无痕窗口。不要复制正在对局的标签页：浏览器可能复制 sessionStorage，导致原玩家身份被接管。
手机横竖屏均可打开；窄屏用对手缩影显示实时阵列，底部触控支持长按。
真正 iOS/Android 真机、移动蜂窝网络和公网延迟需在上线后补测；已做的是本机 Chrome 手机尺寸/触控仿真。

## 选择部署方式

需要一个可以长期运行 Node.js、支持 WebSocket 的服务。**不能只部署 public/ 到静态托管**。
前端和 Socket.io 后端在同一个域名下，无须修改游戏里的服务器地址。
国内云服务器、或你选定的支持国内直连的容器/Node PaaS 均可；具体地域与套餐以平台当前提供的能力为准。

### 方式 A：Node.js PaaS

- 项目根目录：包含 package.json 的目录。
- Node.js 版本：推荐 24 LTS。
- 安装命令：`npm ci --omit=dev --registry=https://registry.npmmirror.com`
- 启动命令：`npm start`
- 监听地址：代码已监听 `0.0.0.0`。
- 端口：读取平台注入的 `PORT`，默认 `3000`。
- 健康检查：`GET /health`。
- 环境变量：`NODE_ENV=production`。前后端同源时无需设置 `FRONTEND_ORIGIN`。
- 实例数：**1**；关闭自动休眠和多实例自动扩容。
- 开启 WebSocket 支持；使用平台提供的 HTTPS 域名或绑定自有域名。
- 如果平台反向代理改写 Host，引起连接被拒，可把 `FRONTEND_ORIGIN` 设置为实际完整网址，例如 `https://game.example.com`，不带末尾斜杠。

### 方式 B：云服务器 Docker + Nginx

仓库自带 Dockerfile，只打包运行依赖、server.js 和 public/，不包含测试工具。
以下命令在已安装 Docker 的 Linux 云服务器项目根目录运行：

```sh
docker build -t jelly-duel:1 .
docker run -d --name jelly-duel --restart unless-stopped \
  -p 127.0.0.1:3000:3000 jelly-duel:1
```

生产环境把 3000 端口仅绑定服务器回环地址，由 Nginx 提供 80/443 访问。
基础镜像需能从你的云服务器拉取；镜像仓库不可达时，使用云厂商提供的可用镜像代理，并替换 Dockerfile 的 FROM 地址。

将 `deploy/nginx.conf.example` 配置加入 Nginx，替换：

1. `game.example.com` → 你的域名；DNS 解析至云服务器公网 IP。
2. 证书路径 → 你的有效 HTTPS 证书路径。
3. 在云安全组及系统防火墙放行 80/443。

配置含 Socket.io 长轮询与 WebSocket 升级支持，代理超时 60 秒。配置后先执行 `nginx -t`，成功再重新加载 Nginx。
国内大陆节点绑定域名上线时，按服务商要求完成域名备案等接入手续。

## 发布后的验收

1. 打开 `https://你的域名/health`，应返回 `{"ok":true}`。
2. 电脑和手机分别打开首页；最好一台 Wi-Fi、一台蜂窝网络。
3. 同房间开局，双方移动、消行、攻击可见，延迟栏显示真实 RTT。
4. 第三位玩家加入同房间应提示已满。
5. 一方断网，另一方显示等待重连；在服务端检测断线后 30 秒内恢复，应保持原棋盘。
6. 刷新页面自动恢复；双方同意“再来一局”后清空棋盘和分数。
7. 一方主动退出或超时，另一方看到胜利及最终对手阵列。

邀请按钮只复制普通房间链接，不包含恢复凭证。在 HTTPS 页面可直接复制；普通 HTTP 可手动复制提示框中的链接。

## 当前服务边界

- 战局保存在单进程内存里：玩家断线可恢复，**服务器重启、升级部署、容器迁移会结束现有战局**。
- 房间号不是账号或私密邀请系统；知道房间号的人可占据空席。
- 页面使用 sessionStorage 保存本标签页的恢复身份；关闭标签页后不保证仍能找回。
- 单人可以随时暂停。联机切后台不会主动暂停另一方；网络断开由服务端统一暂停和恢复。
- 本地已通过规则测试和真实 Socket.io/浏览器联机测试；Docker/Nginx 文件已准备，尚未在你的云环境发布和验证。

准备正式发布时，需要确定平台/服务器和域名。请使用平台登录授权或服务器管理方式接入，不要在聊天里粘贴密码、私钥。
