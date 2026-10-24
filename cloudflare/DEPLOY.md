# 部署结果信箱

Cloudflare Worker 接收 Grok Bot 的结果，Mac 主动取回。使用 Cloudflare 提供的 `workers.dev` 地址即可，无需购买域名，也无需向公网开放 Mac 端口。

## 1. 准备本地配置

在项目根目录运行：

```sh
npm install
chmod +x stackchan
cp bridge.example.json bridge.local.json
chmod 600 bridge.local.json
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { readFileSync, writeFileSync } from "node:fs"; const p="bridge.local.json"; const c=JSON.parse(readFileSync(p,"utf8")); if (!c.relayMasterToken) { c.relayMasterToken=randomBytes(32).toString("base64url"); writeFileSync(p,JSON.stringify(c,null,2)+"\n",{mode:0o600}); }'
```

该命令仅将随机中继密钥写入本地配置，不打印密钥。将 `callbackMode` 保持为 `relay`。Grok webhook key 与中继密钥必须分别配置。

## 2. 登录和部署

```sh
./stackchan cloudflare prepare
./stackchan cloudflare login
./stackchan cloudflare check
./stackchan cloudflare deploy
```

在浏览器中完成 Cloudflare 登录授权。首次使用时，按 Cloudflare 控制台提示启用自己的 `workers.dev` 子域名。

部署脚本会上传 Worker，将中继密钥保存为 Worker 的 `RELAY_MASTER_TOKEN` Secret，并把得到的 HTTPS 根地址写入 `bridge.local.json` 的 `callbackBaseUrl`。它还会生成 `.local/grok-routine-ready.txt`，供创建 Bot 的 webhook routine 使用。部署后的本地文件包含个人端点，保留在本机即可。

Worker 使用 SQLite Durable Object 保存结果；配置见 [wrangler.jsonc](wrangler.jsonc)。使用前可在 [Cloudflare 官方文档](https://developers.cloudflare.com/durable-objects/)确认账号对应的可用性和额度。

## 3. 接入 Grok Bot

将生成的 routine 文本用于你要接入的现有 Grok Bot，创建只通过 webhook 触发的例行任务。然后在本机把 routine 详情中的 POST URL 和 key 分别填写到 `grokWebhookUrl`、`grokWebhookKey`。`relayMasterToken` 只供 Mac 与 Worker 使用，勿交给 Bot。

在 StackChan World 中复制自己的 MCP 接入地址，填写 `mcpEndpoint`。检查并启动：

```sh
./stackchan doctor
./stackchan start
```

Mac 与机器人可以位于不同网络；两者均须保持联网，Mac 须保持唤醒。

## 凭据和结果处理

每个任务使用独立的回调 token；Worker 校验后接收对应结果。Mac 将结果写入本地后才确认取走，Worker 随后清除已确认的结果。不要将 `bridge.local.json`、`.local/`、`.state/`、日志、带 token 的 MCP 地址或 Bot webhook key 上传到仓库、Issue 或截图。
