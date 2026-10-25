# 第一步：准备 GitHub 仓库

本项目已准备好 `render.yaml`，Render 会自动读取 Node.js 启动命令和 `/health` 健康检查。

## 在 GitHub 创建空仓库

1. 登录 GitHub，点击右上角 `+` → `New repository`。
2. 仓库名可以填写 `jelly-duel`。
3. 选择 Public 或 Private 都可以。
4. 创建时不要勾选 README、`.gitignore` 或 License，保持仓库为空。
5. 创建完成后，把仓库页面的网址发给下一步使用；不要发送 GitHub 密码或 Token。

本地上传时应包含：`server.js`、`public/`、`package.json`、`package-lock.json`、`render.yaml`、`.node-version` 等项目文件。
`node_modules/`、`artifacts/`、测试截图和本机日志已经被 `.gitignore` 排除，不需要上传。
