# ADR 0001 — 状态持久化：Host 半侧落盘为主，localStorage 只做首帧缓存

日期：2026-10-20
状态：已接受

## 背景

番茄闹钟需要在**跨刷新、跨重启**之后仍然保留两类数据：

1. 设置：三段时长、长休间隔、提示音音量、系统通知开关、当前任务名；
2. 统计：完成/放弃记录（用于今日数字、近 7 天柱状图、连续天数）。

最直观的做法是把两者都放 `localStorage`。调研后确认这个做法在目标宿主上**不成立**：

- DSH 桌面客户端每次启动都让 web 服务器绑定一个 **OS 分配的端口**（本次会话是 `http://127.0.0.1:49956`），下次启动端口会变；
- `localStorage` 按 **origin（协议 + 主机 + 端口）** 隔离，origin 变了就读不到旧数据；
- 这不是推测：已装在同一 profile 的 `dsh-dream-skin` 在 `lib/index.js` 的头注释与 `docs/desktop-support.md` 里写明了同一条实测结论，并因此额外做了一层 Host 落盘。

另外，DSH 的 Host 设置文档对浏览器只暴露一个**命名空间白名单**，第三方命名空间写不进去（会得到 `settings-not-exposed`），所以「把设置塞进 Host 设置文档」也不是可选项。

## 决策

- 加一个 **Host 半侧**（`index.js`），注册受信任来源栅栏保护的 JSON 路由 `/pomodoro/api`，把状态落盘到 `$DSH_HOME/pomodoro.json`（原子写：tmp + rename，Windows 上失败则直接写）。
- 浏览器半侧（`client.js`）**先读 localStorage 出首帧**（避免闪烁），再用 Host 的权威状态覆盖；所有写入先落 localStorage（同端口生命周期内即时生效），再 debounce 200ms 推给 Host。
- `localStorage` 从「唯一真相」降级为「同 origin 的快速缓存」。

## 为什么不选其它方案

- **只用 localStorage**：重启即丢统计，而统计是本插件明确承诺的功能。
- **Host Config**（`export const Config`）：只能在 `cordis.patch.yml` 里改，无法在设置页运行时改，且要重启；适合静态配置，不适合计时设置与统计。
- **`host.call` RPC**：只存在于 `dsh-cordis-client-runner` 的动态闭包插件形态；本插件用的是 `window.__ModuleLoader__` 形态，没有这个符号。
- **`ctx.storage` / `ctx.storageDomain`**：是 Host 侧的 KV/域设施，没有面向浏览器的暴露面，仍要自己开路由。

## 代价

- 状态读写变成异步：浏览器侧必须处理「Host 未就绪」「Host 不可用」两种降级路径，降级时统计只活在 localStorage 里，必须在设置页**显示降级原因**（不能让用户以为数据保存了）。
- 多一个 Host 文件（`index.js`）和一条自定义 HTTP 路由，需要自己做来源栅栏（loopback / 受信任 authority + 同源标记），防 DNS rebinding 与跨站写入。这条栅栏沿用 `dsh-dream-skin` 已发布实现的判据。

## 后果

- 卸载插件后 `$DSH_HOME/pomodoro.json` 不会被自动删除（与换肤插件的取舍一致：宁可留下一个文件，也不要因为卸载误删用户统计）。README 里写明删除位置。
- 状态文件带 schema 版本键，未来改格式时按版本迁移，不静默丢数据。
