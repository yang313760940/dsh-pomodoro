// dsh-pomodoro — browser half.
//
// Loaded by dsh-client-modules at /plugins/dsh-pomodoro/client.js and executed
// through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table.
//
// The factory only REGISTERS: every side effect (timers, listeners, localStorage,
// AudioContext, <style> insertion) happens inside apply(ctx) and is owned by a
// ctx.effect disposer, so unloading the plugin leaves nothing behind.
//
// Two extension points, both confirmed against the live slot catalog:
//   - conversation.composer.dock (list, session scope) — the ambient countdown
//     row below the composer card;
//   - settings.section (list, root scope) — the "番茄闹钟" settings page
//     holding durations, chimes, notifications, the focus task and statistics.
//
// The whole body is wrapped in try/catch: an escaped exception in a loader-entry
// factory aggregates into "entries did not activate" and can take the Web shell
// down, so a failure here degrades to an inert plugin instead.

window.__ModuleLoader__.load({
  id: "dsh-pomodoro",
  factory(require) {
    try {
      const React = require("react");
      const h = React.createElement;

      // ── constants ───────────────────────────────────────────────────────
      const NS = "pomodoro";
      const LOCAL_KEY = "dsh-pomodoro:state";
      const STATE_VERSION = 1;
      /** Days of focus records kept; older records are pruned on load and append. */
      const RETAIN_DAYS = 90;
      /** Tolerance used to decide whether a phase has "started". */
      const PROGRESS_EPSILON_MS = 500;
      /** Debounce for host persistence pushes. */
      const HOST_PUSH_DELAY_MS = 300;
      /** Bucket for the phase duration limits shown in the settings page. */
      const LIMITS = {
        focusMin: { min: 5, max: 90 },
        shortMin: { min: 1, max: 30 },
        longMin: { min: 5, max: 60 },
        interval: { min: 2, max: 8 },
      };
      const PRESETS = [
        { id: "classic", focusMin: 25, shortMin: 5, longMin: 15 },
        { id: "deep", focusMin: 50, shortMin: 10, longMin: 20 },
        { id: "ultradian", focusMin: 52, shortMin: 17, longMin: 20 },
      ];
      const DEFAULT_SETTINGS = {
        focusMin: 25,
        shortMin: 5,
        longMin: 15,
        interval: 4,
        volume: 70,
        notify: false,
        task: "",
      };

      /** Chinese-only copy (this plugin ships a single UI language). */
      const DICT = {
        "meta.title": "番茄闹钟",
        "dock.start": "开始",
        "dock.pause": "暂停",
        "dock.resume": "继续",
        "dock.reset": "重置",
        "dock.skip": "跳过",
        "dock.confirm": "放弃这一轮？",
        "dock.confirmYes": "确认放弃",
        "dock.confirmNo": "取消",
        "dock.task": "任务：{task}",
        "alert.focus.title": "专注完成",
        "alert.focus.body": "今天已完成 {count} 个番茄，休息一下吧。",
        "alert.focus.overshoot": "离开期间这一轮番茄已经完成，先休息一下。",
        "alert.break.title": "休息结束",
        "alert.break.body": "准备好了就开始下一个番茄。",
        "alert.overshoot.title": "离开期间已完成",
        "alert.startNext": "开始{phase}",
        "alert.dismiss": "知道了",
        "settings.title": "番茄闹钟",
        "settings.desc":
          "专注 / 短休 / 长休三阶段计时。设置与统计保存在本机（$DSH_HOME/pomodoro.json），重启客户端不会丢失。",
        "settings.preset": "预设",
        "settings.preset.classic": "25 / 5 / 15",
        "settings.preset.deep": "50 / 10 / 20",
        "settings.preset.ultradian": "52 / 17 / 20",
        "settings.durations": "时长与周期",
        "settings.focusMin": "专注时长",
        "settings.shortMin": "短休时长",
        "settings.longMin": "长休时长",
        "settings.interval": "长休间隔",
        "settings.intervalHint": "每完成 {n} 个番茄进入一次长休。",
        "settings.minute": "分钟",
        "settings.rounds": "个番茄",
        "settings.reminder": "提醒",
        "settings.volume": "提示音音量",
        "settings.volumeHint": "0 表示静音。专注结束为上行三音，休息结束为下行两音。",
        "settings.notify": "系统通知",
        "settings.notifyOn": "已开启",
        "settings.notifyOff": "已关闭",
        "settings.notifyUnsupported": "当前环境不支持系统通知，已降级为提示音 + 界面提醒。",
        "settings.notifyDenied": "系统通知被拒绝，已降级为提示音 + 界面提醒。可在浏览器地址栏的站点权限里重新允许。",
        "settings.notifyDefault": "开启时会向浏览器请求通知权限；被拒绝会自动降级。",
        "settings.task": "当前任务",
        "settings.taskPlaceholder": "这一轮在做什么（可留空）",
        "settings.taskHint": "只随完成记录保存，用于回顾；本插件不管理任务列表。",
        "settings.stats": "统计",
        "settings.todayPomodoro": "今日番茄",
        "settings.todayMinutes": "今日专注",
        "settings.todayAbandoned": "放弃次数",
        "settings.streak": "连续天数",
        "settings.unitCount": "个",
        "settings.unitMinutes": "分钟",
        "settings.unitDays": "天",
        "settings.last7": "近 7 天完成",
        "settings.dayEmpty": "无记录",
        "settings.clear": "清除全部统计",
        "settings.clearConfirm": "确认清除全部统计？此操作不可撤销。",
        "settings.clearYes": "清除",
        "settings.clearNo": "取消",
        "settings.storageHost": "存储：已落盘到本机文件",
        "settings.storageLocal": "存储：Host 落盘接口不可用，当前只保存在浏览器缓存中（重启可能丢失）。",
        "settings.storageUnknown": "存储：正在连接 Host 落盘接口…",
        "settings.abandonHint":
          "只有自然倒计时结束的专注才计为番茄；点「跳过」或「重置」会记为放弃，单独计数。",
        "phase.focus": "专注",
        "phase.short": "短休",
        "phase.long": "长休",
      };

      // ── pure helpers ───────────────────────────────────────────────────

      /** Clamp an integer into [min, max], falling back when not finite. */
      function clampInt(value, min, max, fallback) {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
      }

      /** Local calendar day key `YYYY-MM-DD` for an epoch timestamp. */
      function dayKey(ts) {
        const d = new Date(ts);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      }

      /** Shift a local day key by whole days. */
      function shiftDayKey(key, delta) {
        const parts = key.split("-").map(Number);
        return dayKey(new Date(parts[0], parts[1] - 1, parts[2] + delta).getTime());
      }

      /** `mm:ss` for an epoch-millisecond duration (seconds round up). */
      function formatClock(ms) {
        const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      }

      /** Planned duration of one phase, in milliseconds. */
      function phaseDuration(settings, phase) {
        if (phase === "short") return settings.shortMin * 60000;
        if (phase === "long") return settings.longMin * 60000;
        return settings.focusMin * 60000;
      }

      /** Human phase name. */
      function phaseName(phase) {
        return phase === "short" ? DICT["phase.short"] : phase === "long" ? DICT["phase.long"] : DICT["phase.focus"];
      }

      /** Settings sanitized against the current limits. */
      function sanitizeSettings(raw) {
        const source = raw !== null && typeof raw === "object" ? raw : {};
        return {
          focusMin: clampInt(source.focusMin, LIMITS.focusMin.min, LIMITS.focusMin.max, DEFAULT_SETTINGS.focusMin),
          shortMin: clampInt(source.shortMin, LIMITS.shortMin.min, LIMITS.shortMin.max, DEFAULT_SETTINGS.shortMin),
          longMin: clampInt(source.longMin, LIMITS.longMin.min, LIMITS.longMin.max, DEFAULT_SETTINGS.longMin),
          interval: clampInt(source.interval, LIMITS.interval.min, LIMITS.interval.max, DEFAULT_SETTINGS.interval),
          volume: clampInt(source.volume, 0, 100, DEFAULT_SETTINGS.volume),
          notify: source.notify === true,
          task: typeof source.task === "string" ? source.task.slice(0, 80) : "",
        };
      }

      /** The pristine state of a fresh install. */
      function createDefaultState() {
        return {
          v: STATE_VERSION,
          rev: 1,
          updatedAt: 0,
          settings: { ...DEFAULT_SETTINGS },
          phase: "focus",
          running: false,
          endsAt: 0,
          remainingMs: DEFAULT_SETTINGS.focusMin * 60000,
          completedFocus: 0,
          history: [],
        };
      }

      /** Whether one loose record is usable. */
      function isRecord(record) {
        return (
          record !== null &&
          typeof record === "object" &&
          typeof record.day === "string" &&
          (record.outcome === "completed" || record.outcome === "abandoned") &&
          Number.isFinite(record.ms)
        );
      }

      /** Drop records older than the retention window. */
      function pruneHistory(history) {
        const cutoff = shiftDayKey(dayKey(Date.now()), -RETAIN_DAYS);
        return history
          .filter(isRecord)
          .filter((record) => record.day >= cutoff)
          .slice(-2000);
      }

      /** Normalize anything read from localStorage or the Host file. */
      function sanitizeState(raw) {
        const base = createDefaultState();
        if (raw === null || typeof raw !== "object") return base;
        const settings = sanitizeSettings(raw.settings);
        const phase = raw.phase === "short" || raw.phase === "long" ? raw.phase : "focus";
        const remaining = Number(raw.remainingMs);
        return {
          v: STATE_VERSION,
          rev: Number.isFinite(Number(raw.rev)) && Number(raw.rev) > 0 ? Math.floor(Number(raw.rev)) : 1,
          updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
          settings,
          phase,
          running: raw.running === true,
          endsAt: Number.isFinite(Number(raw.endsAt)) && Number(raw.endsAt) > 0 ? Number(raw.endsAt) : 0,
          remainingMs: Number.isFinite(remaining) && remaining >= 0 ? remaining : phaseDuration(settings, phase),
          completedFocus:
            Number.isFinite(Number(raw.completedFocus)) && Number(raw.completedFocus) >= 0
              ? Math.floor(Number(raw.completedFocus))
              : 0,
          history: Array.isArray(raw.history) ? pruneHistory(raw.history) : [],
        };
      }

      /**
       * Statistics derived from stored records.
       *
       * - one pomodoro == one focus phase that reached 0 on its own;
       * - abandoned focus phases never count as pomodoros;
       * - "today" is the browser's local calendar day, not UTC;
       * - a streak survives a today with no completed pomodoro yet, because an
       *   unfinished day is not a broken one.
       */
      function computeStats(state) {
        const today = dayKey(Date.now());
        let todayPomodoro = 0;
        let todayMs = 0;
        let todayAbandoned = 0;
        const completedDays = new Set();
        for (const record of state.history) {
          if (record.outcome === "completed") {
            completedDays.add(record.day);
            if (record.day === today) {
              todayPomodoro += 1;
              todayMs += record.ms;
            }
          } else if (record.day === today) {
            todayAbandoned += 1;
          }
        }
        const days = [];
        for (let i = 6; i >= 0; i -= 1) {
          const key = shiftDayKey(today, -i);
          let count = 0;
          for (const record of state.history) {
            if (record.day === key && record.outcome === "completed") count += 1;
          }
          days.push({ key, count, isToday: i === 0 });
        }
        let streak = completedDays.has(today) ? 1 : 0;
        let offset = 1;
        while (completedDays.has(shiftDayKey(today, -offset))) {
          streak += 1;
          offset += 1;
        }
        return {
          todayPomodoro,
          todayMinutes: Math.round(todayMs / 60000),
          todayAbandoned,
          streak,
          days,
        };
      }

      /** Notification capability of this page. */
      function notificationCapability() {
        if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
        const permission = window.Notification.permission;
        if (permission === "granted") return "granted";
        if (permission === "denied") return "denied";
        return "default";
      }

      /** Locale-bound translator with an identity fallback. */
      function makeTranslate(props) {
        if (props !== null && typeof props === "object" && typeof props.t === "function") {
          return (key, params) => props.t(key, params);
        }
        return (key, params) => {
          let text = DICT[key] !== undefined ? DICT[key] : key;
          if (params !== null && typeof params === "object") {
            for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
          }
          return text;
        };
      }

      /**
       * Machine-readable diagnostics mirror on `window`, for verification by the
       * desktop shell or tooling without scraping the console. Read-only and
       * plugin-owned; no data leaves the page.
       */
      function publishStatus(snapshot) {
        if (typeof window === "undefined") return;
        try {
          window.__DSH_POMODORO_STATUS__ = {
            plugin: "dsh-pomodoro",
            build: "1.0.0",
            ready: snapshot !== null,
            phase: snapshot === null ? null : snapshot.phase,
            running: snapshot === null ? false : snapshot.running,
            remainingMs: snapshot === null ? 0 : snapshot.remainingMs,
            completedFocus: snapshot === null ? 0 : snapshot.completedFocus,
            todayPomodoro: snapshot === null ? 0 : snapshot.stats.todayPomodoro,
            hostStatus: snapshot === null ? "unknown" : snapshot.hostStatus,
            notification: snapshot === null ? "unknown" : snapshot.notification,
            audio: snapshot === null ? "unknown" : snapshot.audio,
            checkedAt: Date.now(),
          };
        } catch {
          // A frozen window object must not break the timer.
        }
      }

      // ── runtime ────────────────────────────────────────────────────────

      /**
       * The single global pomodoro clock plus its persisted state.
       *
       * One instance per page: the dock row renders once per Session, but the
       * clock is a global singleton, so every Session shows the same countdown.
       * The state is re-derived from `endsAt` on every tick, which makes the
       * timer immune to interval throttling and lets a reload pick up exactly
       * where the wall clock says it should be.
       */
      function createRuntime(ctx) {
        let state = sanitizeState(readLocalState());
        let alert = null;
        let snapshot = null;
        const listeners = new Set();
        let audioContext = null;
        let audioCapability = "unknown";
        let hostStatus = "unknown"; // 'unknown' | 'ok' | 'unavailable'
        let hostTimer = null;
        let ticker = null;

        /** Path of the Host persistence route, sub-path aware. */
        function hostApiPath() {
          try {
            return new URL("pomodoro/api", document.baseURI || "http://localhost/").pathname;
          } catch {
            return "/pomodoro/api";
          }
        }

        function readLocalState() {
          try {
            const raw = window.localStorage.getItem(LOCAL_KEY);
            return raw === null ? null : JSON.parse(raw);
          } catch {
            return null;
          }
        }

        function writeLocalState() {
          try {
            window.localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
          } catch {
            // Quota or a disabled storage partition: the Host file remains the
            // durable copy, so this is a cache miss, not a data loss.
          }
        }

        /** Cache of the last computed statistics, keyed by the inputs it folds. */
        let statsCache = { history: null, day: null, value: null };

        /**
         * Statistics of the current state, memoized because the ticker rebuilds
         * the snapshot every second and the history never changes on a tick.
         */
        function cachedStats() {
          const today = dayKey(Date.now());
          if (statsCache.history === state.history && statsCache.day === today) return statsCache.value;
          const value = computeStats(state);
          statsCache = { history: state.history, day: today, value };
          return value;
        }

        function buildSnapshot() {
          const total = phaseDuration(state.settings, state.phase);
          const remaining = Math.max(0, Math.min(total, state.remainingMs));
          const interval = Math.max(1, state.settings.interval);
          // "Round" counts completed pomodoros within the current long-break
          // cycle. During the earned long break the cycle is full, so it reads
          // `interval/interval` rather than a confusing 0.
          let roundDone = state.completedFocus % interval;
          if (roundDone === 0 && state.completedFocus > 0 && state.phase === "long") roundDone = interval;
          return {
            phase: state.phase,
            phaseName: phaseName(state.phase),
            running: state.running,
            remainingMs: remaining,
            totalMs: total,
            clock: formatClock(remaining),
            progress: total > 0 ? 1 - remaining / total : 0,
            started: state.running || remaining < total - PROGRESS_EPSILON_MS,
            settings: state.settings,
            completedFocus: state.completedFocus,
            roundDone,
            roundTotal: interval,
            stats: cachedStats(),
            alert,
            notification: notificationCapability(),
            audio: audioCapability,
            hostStatus,
          };
        }

        function emit() {
          snapshot = buildSnapshot();
          publishStatus(snapshot);
          for (const listener of listeners) {
            try {
              listener();
            } catch (error) {
              console.error("[dsh-pomodoro] listener failed:", error);
            }
          }
        }

        /** Persist, bump the revision and notify subscribers. */
        function commit(options) {
          const push = options === undefined || options.push !== false;
          state.rev = (Number(state.rev) || 0) + 1;
          state.updatedAt = Date.now();
          writeLocalState();
          if (push) scheduleHostPush(HOST_PUSH_DELAY_MS);
          emit();
        }

        // ── Host persistence ────────────────────────────────────────────

        function scheduleHostPush(delay) {
          if (hostTimer !== null) return;
          hostTimer = setTimeout(() => {
            hostTimer = null;
            void pushToHost();
          }, delay);
        }

        async function pushToHost() {
          try {
            const response = await fetch(hostApiPath(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method: "set", revision: state.rev, state }),
            });
            if (!response.ok) throw new Error(`http ${response.status}`);
            const payload = await response.json();
            if (payload === null || payload.ok !== true) throw new Error("rejected");
            if (hostStatus !== "ok") {
              hostStatus = "ok";
              emit();
            }
          } catch {
            if (hostStatus !== "unavailable") {
              hostStatus = "unavailable";
              emit();
            }
          }
        }

        async function pullFromHost() {
          try {
            const response = await fetch(hostApiPath(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ method: "get" }),
            });
            if (!response.ok) throw new Error(`http ${response.status}`);
            const payload = await response.json();
            if (payload === null || payload.ok !== true) throw new Error("rejected");
            hostStatus = "ok";
            const remote = payload.value;
            const remoteRevision = remote !== null && typeof remote === "object" ? Number(remote.revision) : 0;
            const remoteState = remote !== null && typeof remote === "object" ? remote.state : null;
            if (remoteState !== null && typeof remoteState === "object" && remoteRevision > state.rev) {
              const adopted = sanitizeState(remoteState);
              adopted.rev = Math.floor(remoteRevision);
              state = adopted;
              writeLocalState();
              restoreFromState();
            } else if (state.rev > (Number.isFinite(remoteRevision) ? remoteRevision : 0)) {
              scheduleHostPush(0);
            }
            emit();
          } catch {
            hostStatus = "unavailable";
            emit();
          }
        }

        // ── phase machine ───────────────────────────────────────────────

        /** Point the clock at a phase, paused at its full duration. */
        function advanceTo(phase) {
          state.phase = phase;
          state.running = false;
          state.endsAt = 0;
          state.remainingMs = phaseDuration(state.settings, phase);
        }

        /** Append one focus record (only focus phases are recorded). */
        function recordFocus(outcome) {
          const planned = phaseDuration(state.settings, "focus");
          const elapsed = outcome === "completed" ? planned : Math.max(0, planned - state.remainingMs);
          state.history = pruneHistory(
            state.history.concat([
              {
                at: Date.now(),
                day: dayKey(Date.now()),
                phase: "focus",
                outcome,
                ms: Math.round(elapsed),
                plannedMs: planned,
                task: state.settings.task,
              },
            ]),
          );
        }

        /** The phase that follows a completed focus phase, given the interval. */
        function breakAfterFocus() {
          const interval = Math.max(1, state.settings.interval);
          return state.completedFocus > 0 && state.completedFocus % interval === 0 ? "long" : "short";
        }

        /** Run the completion path for the phase that just reached 0. */
        function completePhase(options) {
          const overshoot = options !== undefined && options.overshoot === true;
          const ended = state.phase;
          state.running = false;
          state.endsAt = 0;
          state.remainingMs = 0;
          if (ended === "focus") {
            recordFocus("completed");
            state.completedFocus += 1;
            advanceTo(breakAfterFocus());
            const count = computeStats(state).todayPomodoro;
            alert = {
              ended,
              next: state.phase,
              title: overshoot ? DICT["alert.overshoot.title"] : DICT["alert.focus.title"],
              body: overshoot
                ? DICT["alert.focus.overshoot"]
                : DICT["alert.focus.body"].split("{count}").join(String(count)),
            };
            chime("focus");
            notify(DICT["alert.focus.title"], `今天第 ${count} 个番茄完成，休息一下吧。`);
          } else {
            advanceTo("focus");
            alert = {
              ended,
              next: "focus",
              title: DICT["alert.break.title"],
              body: DICT["alert.break.body"],
            };
            chime("break");
            notify(DICT["alert.break.title"], DICT["alert.break.body"]);
          }
          commit();
        }

        /** Re-derive the live clock from a freshly adopted state. */
        function restoreFromState() {
          if (state.running && state.endsAt > 0) {
            const left = state.endsAt - Date.now();
            if (left <= 0) {
              // The page was closed (or reloaded) across the end of the phase.
              // A pomodoro must ring, so this counts as a natural completion.
              state.remainingMs = 0;
              completePhase({ overshoot: true });
              return;
            }
            state.remainingMs = left;
            return;
          }
          state.running = false;
          state.endsAt = 0;
          if (!(state.remainingMs > 0)) state.remainingMs = phaseDuration(state.settings, state.phase);
        }

        // ── sound ───────────────────────────────────────────────────────

        function ensureAudio() {
          if (audioContext !== null) return audioContext;
          const Ctor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : undefined;
          if (typeof Ctor !== "function") {
            audioCapability = "unsupported";
            return null;
          }
          try {
            audioContext = new Ctor();
            audioCapability = "ok";
            return audioContext;
          } catch {
            audioCapability = "unsupported";
            return null;
          }
        }

        /**
         * Synthesize the phase chime: focus end is a rising triad, break end a
         * falling pair. Synthesized on purpose — no audio asset to ship or
         * license, and volume follows the settings slider exactly.
         */
        function chime(kind) {
          const volume = state.settings.volume / 100;
          if (!(volume > 0)) return;
          const audio = ensureAudio();
          if (audio === null) return;
          try {
            if (audio.state === "suspended") void audio.resume();
            const now = audio.currentTime;
            const notes = kind === "focus" ? [523.25, 659.25, 783.99] : [659.25, 523.25];
            notes.forEach((frequency, index) => {
              const oscillator = audio.createOscillator();
              const gain = audio.createGain();
              const start = now + index * 0.16;
              oscillator.type = "sine";
              oscillator.frequency.value = frequency;
              gain.gain.setValueAtTime(0.0001, start);
              gain.gain.exponentialRampToValueAtTime(0.28 * volume, start + 0.03);
              gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
              oscillator.connect(gain).connect(audio.destination);
              oscillator.start(start);
              oscillator.stop(start + 0.5);
            });
            audioCapability = "ok";
          } catch {
            audioCapability = "unsupported";
          }
        }

        // ── system notification ─────────────────────────────────────────

        function notify(title, body) {
          if (!state.settings.notify) return;
          if (notificationCapability() !== "granted") return;
          try {
            new window.Notification(title, { body, tag: "dsh-pomodoro", silent: true });
          } catch {
            // A refused notification must never take the timer down.
          }
        }

        async function setNotify(enabled) {
          state.settings.notify = enabled === true;
          if (state.settings.notify) {
            const capability = notificationCapability();
            if (capability === "default" && typeof window !== "undefined" && window.Notification !== undefined) {
              try {
                await window.Notification.requestPermission();
              } catch {
                // ignore: the settings page reports the resulting capability
              }
            }
            if (notificationCapability() !== "granted") state.settings.notify = false;
          }
          commit();
        }

        // ── ticker ──────────────────────────────────────────────────────

        function tick() {
          if (!state.running || state.endsAt <= 0) return;
          const left = state.endsAt - Date.now();
          if (left <= 0) {
            state.remainingMs = 0;
            completePhase();
            return;
          }
          // The row renders whole seconds, so a tick that does not cross a
          // second boundary changes nothing the user can see: skip the emit
          // instead of re-rendering the dock twice a second.
          const beforeSecond = Math.ceil(state.remainingMs / 1000);
          state.remainingMs = left;
          if (Math.ceil(left / 1000) === beforeSecond) return;
          emit();
        }

        // ── public actions ──────────────────────────────────────────────

        function start() {
          alert = null;
          if (state.running) {
            emit();
            return;
          }
          // The click is a user gesture — the only reliable moment to create
          // an AudioContext under browser autoplay policy.
          ensureAudio();
          const total = phaseDuration(state.settings, state.phase);
          if (!(state.remainingMs > 0) || state.remainingMs > total) state.remainingMs = total;
          state.running = true;
          state.endsAt = Date.now() + state.remainingMs;
          commit();
        }

        function pause() {
          if (!state.running) return;
          state.remainingMs = Math.max(0, state.endsAt - Date.now());
          state.running = false;
          state.endsAt = 0;
          commit();
        }

        function toggle() {
          if (state.running) pause();
          else start();
        }

        function dismissAlert() {
          if (alert === null) return;
          alert = null;
          emit();
        }

        function resetPhase() {
          alert = null;
          const total = phaseDuration(state.settings, state.phase);
          const started = state.running || state.remainingMs < total - PROGRESS_EPSILON_MS;
          if (state.phase === "focus" && started) recordFocus("abandoned");
          state.running = false;
          state.endsAt = 0;
          state.remainingMs = total;
          commit();
        }

        function skipPhase() {
          alert = null;
          const ended = state.phase;
          const total = phaseDuration(state.settings, ended);
          const started = state.running || state.remainingMs < total - PROGRESS_EPSILON_MS;
          state.running = false;
          state.endsAt = 0;
          if (ended === "focus") {
            if (!started) {
              // Nothing to abandon yet: skipping an idle focus phase just
              // re-arms it, so an accidental click cannot cost a record.
              advanceTo("focus");
            } else {
              recordFocus("abandoned");
              // A long break is earned by completed pomodoros only, so skipping
              // a focus phase leads to a short break.
              advanceTo("short");
            }
          } else {
            advanceTo("focus");
          }
          commit();
        }

        function applySettings(patch) {
          const previous = state.settings;
          const next = sanitizeSettings({ ...previous, ...patch });
          const beforeDuration = phaseDuration(previous, state.phase);
          const atFullDuration = !state.running && state.remainingMs >= beforeDuration - PROGRESS_EPSILON_MS;
          state.settings = next;
          if (!state.running && atFullDuration) state.remainingMs = phaseDuration(next, state.phase);
          commit();
        }

        function applyPreset(preset) {
          applySettings({ focusMin: preset.focusMin, shortMin: preset.shortMin, longMin: preset.longMin });
        }

        function clearStats() {
          state.history = [];
          state.completedFocus = 0;
          commit();
        }

        const runtime = {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          start,
          pause,
          toggle,
          dismissAlert,
          resetPhase,
          skipPhase,
          applySettings,
          applyPreset,
          setNotify,
          clearStats,
          /** Boot: install the ticker/listeners, then reconcile with the Host. */
          mount() {
            restoreFromState();
            emit();
            ticker = setInterval(tick, 500);
            ctx.effect(
              () => () => {
                if (ticker !== null) clearInterval(ticker);
                ticker = null;
                if (hostTimer !== null) clearTimeout(hostTimer);
                hostTimer = null;
                if (audioContext !== null) {
                  try {
                    void audioContext.close();
                  } catch {
                    // already closed
                  }
                  audioContext = null;
                }
              },
              "dsh-pomodoro: timer and audio teardown",
            );
            ctx.effect(
              () => {
                const onVisibility = () => {
                  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
                  // A throttled background interval can overshoot the end time.
                  tick();
                };
                document.addEventListener("visibilitychange", onVisibility);
                return () => document.removeEventListener("visibilitychange", onVisibility);
              },
              "dsh-pomodoro: visibility resync",
            );
            void pullFromHost();
          },
        };
        snapshot = buildSnapshot();
        return runtime;
      }

      // ── styles ────────────────────────────────────────────────────────

      const CSS = `
.dsh-pomodoro-dock {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-family: var(--dsw-font-family, inherit);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-pomodoro-dock__phase {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-pomodoro-dock__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-pomodoro-dock[data-phase="short"] .dsh-pomodoro-dock__dot,
.dsh-pomodoro-dock[data-phase="long"] .dsh-pomodoro-dock__dot {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-pomodoro-dock[data-running="true"] .dsh-pomodoro-dock__dot {
  animation: dsh-pomodoro-pulse 2s ease-in-out infinite;
}
@keyframes dsh-pomodoro-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: .45; transform: scale(.8); }
}
.dsh-pomodoro-dock__clock {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  letter-spacing: .02em;
}
.dsh-pomodoro-dock__bar {
  position: relative;
  width: 84px;
  height: 4px;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2);
  overflow: hidden;
}
.dsh-pomodoro-dock__fill {
  position: absolute;
  inset: 0 auto 0 0;
  height: 100%;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
  transition: width .4s linear;
}
.dsh-pomodoro-dock[data-phase="short"] .dsh-pomodoro-dock__fill,
.dsh-pomodoro-dock[data-phase="long"] .dsh-pomodoro-dock__fill {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-pomodoro-dock__round {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-pomodoro-dock__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-pomodoro-dock__button {
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-pomodoro-dock__button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-dock__button:disabled {
  opacity: .45;
  cursor: default;
}
.dsh-pomodoro-dock__button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsh-pomodoro-dock__button--primary {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-pomodoro-dock__button--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-pomodoro-dock__button--danger {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-pomodoro-dock__hint {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pomodoro-dock[data-alert="true"] {
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-bg-layer-2));
}
.dsh-pomodoro-dock__alert {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-dock__alert strong {
  font-weight: 600;
}
.dsh-pomodoro-dock__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
.dsh-pomodoro-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 620px;
  padding: 4px 2px 24px;
  font-family: var(--dsw-font-family, inherit);
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.dsh-pomodoro-card__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-card__hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pomodoro-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-pomodoro-row__label {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dsh-pomodoro-input {
  width: 68px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.dsh-pomodoro-input:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
.dsh-pomodoro-input--wide {
  width: 100%;
  max-width: 320px;
}
.dsh-pomodoro-unit {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pomodoro-presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-pomodoro-chip {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-pomodoro-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-chip[data-active="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-pomodoro-switch {
  position: relative;
  width: 36px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2));
  cursor: pointer;
  transition: background .15s ease;
}
.dsh-pomodoro-switch[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary);
}
.dsh-pomodoro-switch__knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform .15s ease;
}
.dsh-pomodoro-switch[aria-checked="true"] .dsh-pomodoro-switch__knob {
  transform: translateX(16px);
}
.dsh-pomodoro-switch:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 2px;
}
.dsh-pomodoro-range {
  width: 180px;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-pomodoro-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 10px;
}
.dsh-pomodoro-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-pomodoro-stat__value {
  font-size: 22px;
  font-weight: 600;
  line-height: 28px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.dsh-pomodoro-stat__label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pomodoro-chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 84px;
}
.dsh-pomodoro-chart__col {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 100%;
}
.dsh-pomodoro-chart__bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 2px 2px;
  background: var(--dsw-alias-brand-primary);
  opacity: .8;
}
.dsh-pomodoro-chart__col[data-today="true"] .dsh-pomodoro-chart__bar {
  opacity: 1;
}
.dsh-pomodoro-chart__label {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
.dsh-pomodoro-chart__count {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dsh-pomodoro-status {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-pomodoro-status[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-pomodoro-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.dsh-pomodoro-button {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-pomodoro-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-pomodoro-button--danger {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-pomodoro-button:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 1px;
}
`;

      // ── components ────────────────────────────────────────────────────

      /** The runtime created by apply(); components read it through this. */
      let runtime = null;

      /** Subscribe a component to the singleton clock. */
      function useClock() {
        const store = runtime;
        const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        return snapshot;
      }

      /** Small class-based buttons keep the dock row compact. */
      function buildButton(label, onClick, options) {
        const settings = options === undefined ? {} : options;
        return h(
          "button",
          {
            type: "button",
            className: `dsh-pomodoro-dock__button${settings.variant ? ` dsh-pomodoro-dock__button--${settings.variant}` : ""}`,
            onClick,
            disabled: settings.disabled === true,
            title: settings.title,
            "aria-label": settings.title,
          },
          label,
        );
      }

      /** The ambient countdown row below the composer card. */
      function DockRow(props) {
        const snapshot = useClock();
        const t = makeTranslate(props);
        const [confirm, setConfirm] = React.useState(null);
        const started = snapshot.started;
        const running = snapshot.running;

        const primaryLabel = running
          ? t("dock.pause")
          : started
            ? t("dock.resume")
            : t("dock.start");

        const onRequestReset = () => {
          if (snapshot.phase === "focus" && started) setConfirm("reset");
          else {
            runtime.resetPhase();
            setConfirm(null);
          }
        };
        const onRequestSkip = () => {
          if (snapshot.phase === "focus" && started) setConfirm("skip");
          else {
            runtime.skipPhase();
            setConfirm(null);
          }
        };
        const onConfirm = () => {
          if (confirm === "reset") runtime.resetPhase();
          else runtime.skipPhase();
          setConfirm(null);
        };
        const startNext = () => {
          runtime.start();
        };

        const roundText = `${snapshot.roundDone}/${snapshot.roundTotal}`;

        const taskTitle =
          snapshot.settings.task.length > 0
            ? `${t("dock.task", { task: snapshot.settings.task })} · ${snapshot.phaseName} ${snapshot.clock}`
            : `${snapshot.phaseName} ${snapshot.clock}`;

        const children = [
          h(
            "span",
            { key: "phase", className: "dsh-pomodoro-dock__phase", title: taskTitle },
            h("span", { className: "dsh-pomodoro-dock__dot", "aria-hidden": "true" }),
            snapshot.phaseName,
          ),
          h(
            "span",
            {
              key: "clock",
              className: "dsh-pomodoro-dock__clock",
              role: "timer",
              "aria-live": "off",
              "aria-label": `${snapshot.phaseName} ${snapshot.clock}`,
            },
            snapshot.clock,
          ),
          h(
            "span",
            { key: "bar", className: "dsh-pomodoro-dock__bar", "aria-hidden": "true" },
            h("span", { className: "dsh-pomodoro-dock__fill", style: { width: `${Math.round(snapshot.progress * 100)}%` } }),
          ),
          h(
            "span",
            { key: "round", className: "dsh-pomodoro-dock__round", title: t("settings.intervalHint", { n: snapshot.roundTotal }) },
            roundText,
          ),
        ];

        if (confirm !== null) {
          children.push(
            h(
              "span",
              { key: "confirm", className: "dsh-pomodoro-dock__actions" },
              h("span", { className: "dsh-pomodoro-dock__hint" }, t("dock.confirm")),
              buildButton(t("dock.confirmYes"), onConfirm, { variant: "danger" }),
              buildButton(t("dock.confirmNo"), () => setConfirm(null)),
            ),
          );
        } else {
          children.push(
            h(
              "span",
              { key: "actions", className: "dsh-pomodoro-dock__actions" },
              buildButton(primaryLabel, () => runtime.toggle(), { variant: "primary" }),
              buildButton(t("dock.reset"), onRequestReset, { disabled: !started, title: t("dock.reset") }),
              // Skip stays available while idle: skipping a break that has not
              // started yet is a legitimate way back to focus.
              buildButton(t("dock.skip"), onRequestSkip, { title: t("dock.skip") }),
            ),
          );
        }

        const alert = snapshot.alert;
        if (alert !== null) {
          children.push(
            h(
              "span",
              { key: "alert", className: "dsh-pomodoro-dock__alert", role: "status" },
              h("strong", null, alert.title),
              h("span", null, alert.body),
              buildButton(t("alert.startNext", { phase: phaseName(alert.next) }), startNext, {
                variant: "primary",
              }),
              buildButton(t("alert.dismiss"), () => runtime.dismissAlert()),
            ),
          );
        }

        return h(
          "div",
          {
            className: "dsh-pomodoro-dock",
            "data-phase": snapshot.phase,
            "data-running": running ? "true" : "false",
            "data-alert": alert !== null ? "true" : "false",
          },
          children,
        );
      }

      /** A number input that only commits valid values, on blur or Enter. */
      function NumberField(props) {
        const [draft, setDraft] = React.useState(String(props.value));
        React.useEffect(() => {
          setDraft(String(props.value));
        }, [props.value]);
        const commit = () => {
          const next = clampInt(draft, props.min, props.max, props.value);
          props.onCommit(next);
          setDraft(String(next));
        };
        return h(
          "label",
          { className: "dsh-pomodoro-field" },
          h("span", { className: "dsh-pomodoro-unit" }, props.label),
          h("input", {
            className: "dsh-pomodoro-input",
            type: "number",
            inputMode: "numeric",
            min: props.min,
            max: props.max,
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            },
          }),
          h("span", { className: "dsh-pomodoro-unit" }, props.unit),
        );
      }

      /** The "番茄闹钟" settings page. */
      function SettingsSection(props) {
        const snapshot = useClock();
        const t = makeTranslate(props);
        const settings = snapshot.settings;
        const stats = snapshot.stats;
        const [confirmClear, setConfirmClear] = React.useState(false);

        const presetActive = (preset) =>
          settings.focusMin === preset.focusMin &&
          settings.shortMin === preset.shortMin &&
          settings.longMin === preset.longMin;

        const maxBar = Math.max(1, ...stats.days.map((day) => day.count));

        const notificationStatus = (() => {
          if (snapshot.notification === "unsupported") return { text: t("settings.notifyUnsupported"), tone: "warn" };
          if (snapshot.notification === "denied") return { text: t("settings.notifyDenied"), tone: "warn" };
          if (snapshot.notification === "granted") {
            return { text: settings.notify ? t("settings.notifyOn") : t("settings.notifyOff"), tone: "plain" };
          }
          return { text: t("settings.notifyDefault"), tone: "plain" };
        })();

        const storageStatus = (() => {
          if (snapshot.hostStatus === "ok") return { text: t("settings.storageHost"), tone: "plain" };
          if (snapshot.hostStatus === "unavailable") return { text: t("settings.storageLocal"), tone: "warn" };
          return { text: t("settings.storageUnknown"), tone: "plain" };
        })();

        // Section card. Takes a title followed by any number of body nodes, so
        // a card can hold rows, hints and status lines without a wrapper.
        const card = (title, ...body) =>
          h("section", { className: "dsh-pomodoro-card" }, h("h3", { className: "dsh-pomodoro-card__title" }, title), body);

        return h(
          "div",
          { className: "dsh-pomodoro-settings" },
          h("h2", { style: { fontSize: 16, fontWeight: 600, margin: 0 } }, t("settings.title")),
          h("p", { className: "dsh-pomodoro-card__hint", style: { margin: 0 } }, t("settings.desc")),

          card(
            t("settings.preset"),
            h(
              "div",
              { className: "dsh-pomodoro-presets" },
              PRESETS.map((preset) =>
                h(
                  "button",
                  {
                    key: preset.id,
                    type: "button",
                    className: "dsh-pomodoro-chip",
                    "data-active": presetActive(preset) ? "true" : "false",
                    onClick: () => runtime.applyPreset(preset),
                  },
                  t(`settings.preset.${preset.id}`),
                ),
              ),
            ),
          ),

          card(
            t("settings.durations"),
            h(
              "div",
              { className: "dsh-pomodoro-row" },
              h(NumberField, {
                label: t("settings.focusMin"),
                value: settings.focusMin,
                min: LIMITS.focusMin.min,
                max: LIMITS.focusMin.max,
                unit: t("settings.minute"),
                onCommit: (value) => runtime.applySettings({ focusMin: value }),
              }),
              h(NumberField, {
                label: t("settings.shortMin"),
                value: settings.shortMin,
                min: LIMITS.shortMin.min,
                max: LIMITS.shortMin.max,
                unit: t("settings.minute"),
                onCommit: (value) => runtime.applySettings({ shortMin: value }),
              }),
              h(NumberField, {
                label: t("settings.longMin"),
                value: settings.longMin,
                min: LIMITS.longMin.min,
                max: LIMITS.longMin.max,
                unit: t("settings.minute"),
                onCommit: (value) => runtime.applySettings({ longMin: value }),
              }),
              h(NumberField, {
                label: t("settings.interval"),
                value: settings.interval,
                min: LIMITS.interval.min,
                max: LIMITS.interval.max,
                unit: t("settings.rounds"),
                onCommit: (value) => runtime.applySettings({ interval: value }),
              }),
            ),
            h("p", { className: "dsh-pomodoro-card__hint", style: { margin: 0 } }, t("settings.intervalHint", { n: settings.interval })),
            h("p", { className: "dsh-pomodoro-card__hint", style: { margin: 0 } }, t("settings.abandonHint")),
          ),

          card(
            t("settings.reminder"),
            h(
              "div",
              { className: "dsh-pomodoro-row" },
              h("span", { className: "dsh-pomodoro-row__label" }, t("settings.volume")),
              h(
                "span",
                { className: "dsh-pomodoro-field" },
                h("input", {
                  className: "dsh-pomodoro-range",
                  type: "range",
                  min: 0,
                  max: 100,
                  step: 5,
                  value: settings.volume,
                  "aria-label": t("settings.volume"),
                  onChange: (event) => runtime.applySettings({ volume: Number(event.target.value) }),
                }),
                h("span", { className: "dsh-pomodoro-unit" }, `${settings.volume}%`),
              ),
            ),
            h(
              "div",
              { className: "dsh-pomodoro-row" },
              h("span", { className: "dsh-pomodoro-row__label" }, t("settings.notify")),
              h(
                "button",
                {
                  type: "button",
                  className: "dsh-pomodoro-switch",
                  role: "switch",
                  "aria-checked": settings.notify ? "true" : "false",
                  "aria-label": t("settings.notify"),
                  onClick: () => void runtime.setNotify(!settings.notify),
                },
                h("span", { className: "dsh-pomodoro-switch__knob" }),
              ),
            ),
            h("p", { className: "dsh-pomodoro-card__hint", style: { margin: 0 } }, t("settings.volumeHint")),
            h(
              "p",
              { className: "dsh-pomodoro-status", "data-tone": notificationStatus.tone, style: { margin: 0 } },
              notificationStatus.text,
            ),
          ),

          card(
            t("settings.task"),
            h("input", {
              className: "dsh-pomodoro-input dsh-pomodoro-input--wide",
              type: "text",
              maxLength: 80,
              placeholder: t("settings.taskPlaceholder"),
              value: settings.task,
              "aria-label": t("settings.task"),
              onChange: (event) => runtime.applySettings({ task: event.target.value }),
            }),
            h("p", { className: "dsh-pomodoro-card__hint", style: { margin: 0 } }, t("settings.taskHint")),
          ),

          card(
            t("settings.stats"),
            h(
              "div",
              { className: "dsh-pomodoro-stats" },
              [
                { key: "pomodoro", value: stats.todayPomodoro, unit: t("settings.unitCount"), label: t("settings.todayPomodoro") },
                { key: "minutes", value: stats.todayMinutes, unit: t("settings.unitMinutes"), label: t("settings.todayMinutes") },
                { key: "abandoned", value: stats.todayAbandoned, unit: t("settings.unitCount"), label: t("settings.todayAbandoned") },
                { key: "streak", value: stats.streak, unit: t("settings.unitDays"), label: t("settings.streak") },
              ].map((stat) =>
                h(
                  "div",
                  { key: stat.key, className: "dsh-pomodoro-stat" },
                  h("span", { className: "dsh-pomodoro-stat__value" }, `${stat.value}${stat.unit}`),
                  h("span", { className: "dsh-pomodoro-stat__label" }, stat.label),
                ),
              ),
            ),
            h(
              "div",
              { className: "dsh-pomodoro-chart", role: "img", "aria-label": t("settings.last7") },
              stats.days.map((day) =>
                h(
                  "div",
                  { key: day.key, className: "dsh-pomodoro-chart__col", "data-today": day.isToday ? "true" : "false" },
                  h("span", { className: "dsh-pomodoro-chart__count" }, day.count > 0 ? String(day.count) : ""),
                  h("span", {
                    className: "dsh-pomodoro-chart__bar",
                    style: { height: `${Math.round((day.count / maxBar) * 100)}%` },
                    title: `${day.key}${day.count > 0 ? ` · ${day.count}` : ` · ${t("settings.dayEmpty")}`}`,
                  }),
                  h("span", { className: "dsh-pomodoro-chart__label" }, day.key.slice(5)),
                ),
              ),
            ),
            h(
              "div",
              { className: "dsh-pomodoro-actions" },
              confirmClear
                ? [
                    h("span", { key: "ask", className: "dsh-pomodoro-status", "data-tone": "warn" }, t("settings.clearConfirm")),
                    h(
                      "button",
                      {
                        key: "yes",
                        type: "button",
                        className: "dsh-pomodoro-button dsh-pomodoro-button--danger",
                        onClick: () => {
                          runtime.clearStats();
                          setConfirmClear(false);
                        },
                      },
                      t("settings.clearYes"),
                    ),
                    h(
                      "button",
                      { key: "no", type: "button", className: "dsh-pomodoro-button", onClick: () => setConfirmClear(false) },
                      t("settings.clearNo"),
                    ),
                  ]
                : h(
                    "button",
                    {
                      type: "button",
                      className: "dsh-pomodoro-button",
                      onClick: () => setConfirmClear(true),
                    },
                    t("settings.clear"),
                  ),
            ),
          ),

          h("p", { className: "dsh-pomodoro-status", "data-tone": storageStatus.tone, style: { margin: 0 } }, storageStatus.text),
        );
      }

      // ── plugin body ───────────────────────────────────────────────────

      return {
        inject: ["slots", "locale"],
        apply(ctx) {
          runtime = createRuntime(ctx);
          runtime.mount();

          // The page shell owns scroll chrome; our styles are namespaced under
          // the `dsh-pomodoro-` prefix and only reference --dsw-* tokens.
          ctx.effect(
            () => {
              if (typeof document === "undefined") return () => {};
              const tag = document.createElement("style");
              tag.dataset.plugin = "dsh-pomodoro";
              tag.dataset.pluginCss = "dsh-pomodoro/client.css";
              tag.textContent = CSS;
              document.head.appendChild(tag);
              return () => tag.remove();
            },
            "dsh-pomodoro: stylesheet",
          );

          // Chinese-only UI: the same dictionary answers both languages so no
          // raw key can reach the screen, and the registry is keyed by `NS`
          // which the slot registrations below declare as their locale face.
          ctx.effect(() => ctx.locale.register(NS, { zh: DICT, en: DICT }), "dsh-pomodoro: dictionaries");

          ctx.slots.inject("conversation.composer.dock", () =>
            ctx.slots.register(
              {
                name: "conversation.composer.dock",
                id: "dsh-pomodoro",
                order: 20,
                locale: NS,
              },
              DockRow,
            ),
          );

          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              {
                name: "settings.section",
                id: "dsh-pomodoro",
                order: 12,
                label: DICT["meta.title"],
                locale: NS,
              },
              SettingsSection,
            ),
          );
        },
      };
    } catch (error) {
      // Never let a factory failure take the whole Web shell down.
      console.error("[dsh-pomodoro] client factory failed to initialize:", error);
      return { inject: [], apply() {} };
    }
  },
});
