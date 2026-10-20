# dsh-pomodoro — DeepSeek Harness 番茄闹钟插件

一个 [DeepSeek Harness](https://github.com/)（DSH）Web / 桌面客户端插件：**专注 / 短休 / 长休**三阶段番茄计时，输入框下方常驻倒计时，阶段结束提醒，今日与近 7 天统计。设置与统计落盘到 `$DSH_HOME/pomodoro.json`，**重启客户端不丢**。

- 目标宿主：DSH Desktop `0.2.1-rc.2`（Web 面）
- 插件形态：`window.__ModuleLoader__` 客户端 bundle + Host 半侧（受信任来源栅栏保护的 JSON 路由）
- 运行环境：Node ≥ 20、浏览器支持 `AudioContext` / `localStorage`（`IntersectionObserver` 非必需）
- 界面语言：中文（`locale/en.json` 仅为英文界面的插件管理器提供元数据，运行时文案为中文）

## 功能一览

### 计时

- 三阶段：专注 / 短休 / 长休；开始 / 暂停 / 继续 / 重置 / 跳过
- 半自动流转：阶段自然结束后自动切到下一阶段并**暂停**，等用户点开始
- 长休由「每 N 个**已完成**番茄」触发（独立计数，非时长推算）
- 全局单例计时器：所有会话看到同一个番茄钟
- 刷新/重开页面按 `endsAt` 恢复剩余时间；离开期间跨过结束时间 → 视为**自然完成**，停在下一阶段并说明
- 倒计时不受后台 interval 节流影响（每次心跳按墙钟重算）

### 时长与周期

- 专注 5–90 分钟（默认 25）、短休 1–30 分钟（默认 5）、长休 5–60 分钟（默认 15）均可调
- 长休间隔 2–8 个番茄可调（默认 4）
- 三个预设一键切换：`25/5/15`、`50/10/20`、`52/17/20`

### 提醒

- 提示音：专注结束＝上行三音，休息结束＝下行两音（Web Audio 现场合成，无音频素材）
- 音量 0–100% 滑杆（0 即静音）
- 界面内醒目提醒：dock 行变强调底色 + 标题文案 + 「开始短休 / 知道了」
- 系统通知开关，**默认关闭**；首次开启才请求权限
- 通知不可用/被拒绝 → 自动降级为「提示音 + 界面提醒」，设置页**显示原因**

### 状态显示

- dock 单行：阶段标签 + `mm:ss` + 细进度条 + 轮次 `n/N`
- 单行完整控制：开始/暂停、重置、跳过（配置全在设置页）
- 当前任务名出现在 hover 提示与结束文案里
- 全部颜色走 `--dsw-alias-*` 主题 token，跟随明暗与皮肤

### 统计

- 今日番茄数（只计**自然完成**的专注段）、今日专注分钟数
- 今日放弃次数（跳过/重置的**已开始**专注段，单独计数）
- 连续专注天数 streak（一天 ≥1 个完成即算；今天未完不算断）
- 近 7 天柱状图（今天高亮）；记录保留 90 天滚动，超期自动裁剪
- 「清除全部统计」带二次确认

### 设置与持久化

- 独立设置页「番茄闹钟」，位于设置侧栏
- 设置与统计落盘到 `$DSH_HOME/pomodoro.json`（跨重启保留）；`localStorage` 仅作首帧缓存
- Host 接口不可用时降级为仅浏览器缓存，并在设置页显示降级提示
- 修订号单调：旧页面无法把落盘数据回滚；损坏的状态文件读作空记录，不崩插件

## 安装

### 方式一：DSH 内安装（推荐）

1. 下载本仓库的 `dsh-pomodoro/` 目录到本地任意位置（不要放进 `$DSH_HOME`）：

   ```powershell
   git clone https://github.com/yang313760940/dsh-pomodoro.git
   ```

2. 在 DSH 里让 Agent 执行 `plugin_manager`：
   - `action: install_bundle`
   - `target: <dsh-pomodoro 目录的绝对路径>`
   - 返回 `application: applied` 后，刷新页面即生效。

3. 或在 **设置 → 插件 → 添加** 里用本地目录安装（等价路径）。

> 不要在 profile 目录里手写 `package.json` / `cordis.patch.yml`，也不要跑 `pnpm`——`install_bundle` 负责这些步骤。

### 启用 / 禁用 / 卸载

| 操作 | 做法 | 效果 |
|---|---|---|
| 禁用 | `plugin_manager` `set_bundle`，`target: dsh-pomodoro`，`enabled: false` | dock 行与设置页消失；已落盘数据保留 |
| 启用 | 同上，`enabled: true` | 重新挂载 |
| 卸载 | `plugin_manager` `remove_bundle`，`target: dsh-pomodoro` | 移除依赖；`$DSH_HOME/pomodoro.json` **不会**被自动删除，需要清干净请手动删该文件 |

> 替换已安装包的代码需要**重启客户端**（新装可能靠 HMR 直接生效，替换已装包需要重启以加载新的 JS 代码）。

## 使用

1. 安装后刷新页面，打开任一会话：输入框下方出现番茄倒计时行。
2. 点击「开始」进入专注计时；阶段自然结束会自动切到下一阶段并暂停，同时播放提示音（首次点击后才有声，浏览器要求一次用户手势才能创建 AudioContext）。
3. **设置 → 侧栏「番茄闹钟」**：调整三段时长、长休间隔、预设、音量、系统通知、当前任务名。
4. dock 行的进度条与轮次计数实时反映当前轮次；统计在设置页查看。

## 仓库结构

```
dsh-pomodoro/                 ← 插件包本体（安装这个目录）
├── package.json              包清单：dsh.bundle / dsh.client / exports / files / icon
├── cordis.patch.yml          向 Loader 树插入一行 dsh-pomodoro（同时激活 Host 半与 Client 半）
├── index.js                  Host 半：注册 /pomodoro/api，原子读写 $DSH_HOME/pomodoro.json
├── client.js                 浏览器半：计时状态机 + 两个槽位组件 + 提示音 + 统计
├── locale/zh.json            插件管理器里显示的标题与描述（中文）
├── locale/en.json            同上（英文）
└── icon.svg                  插件图标
tests/                        离线测试（纯 Node、无外网、无浏览器）
GLOSSARY.md                   领域词汇表（番茄 / 放弃 / 自然完成 / streak …）
docs/adr/                     架构决策记录
```

## 开发与测试

```powershell
node --check dsh-pomodoro/client.js
node --check dsh-pomodoro/index.js
node tests/copy.cjs
node tests/smoke.cjs
node tests/reload.cjs
node tests/host-api.cjs
```

- `tests/smoke.cjs`：浏览器半冒烟测试（17 组断言）
- `tests/reload.cjs`：刷新/跨阶段结束场景（5 组场景）
- `tests/host-api.cjs`：Host 路由测试（来源栅栏、修订号、原子写，11 组断言）
- `tests/copy.cjs`：静态一致性（t() 键有译文、无死文案、清单导出展示资源）

## 已知边界

1. **UI 文案仅中文**。运行时字典对 `en` 也返回中文，避免英文界面出现裸 key。
2. **系统通知在桌面壳里可能被平台层拦截**，代码按「不可用即降级并显示原因」处理。
3. **提示音需要一次用户手势**才能创建 AudioContext，首次点击「开始」后才有声。
4. **统计按浏览器时区的本地自然日划分**，跨时区旅行时历史记录的归属日不会重算。
5. **`endsAt` 依赖本机时钟**，系统时间被手动大幅调整时倒计时按新墙钟重算。
6. **未做**（不在当前范围）：独立侧边栏面板/全局浮窗、任务列表与预估番茄、白噪音、网站屏蔽、跨设备同步、数据导出、30 天趋势。

## 许可证

[MIT](./LICENSE) © 2026 yang313760940
