//! 系統管理的「主機監控」（`/admin/system`）：整台主機的 CPU、記憶體、磁碟、網路，以及主機上每個服務
//! （systemd 服務、Docker 容器、SSH 開的工作階段）各用了多少，Discord bot 之類的也在裡面。
//!
//! 資料全部讀 Linux 的 /proc。容器裡的 /proc 只看得到自己的行程，所以 compose.yaml 把主機的 /proc
//! 唯讀掛到 /host/proc，`HOST_PROC` 指過去。行程依 `/proc/<pid>/cgroup` 分組：同一個 systemd 服務或
//! Docker 容器算一組，不用另外設定。管理員可以把關心的服務加進「監控清單」（`monitor_targets`），
//! cgroup 名稱或指令列含有關鍵字的行程都算它的，一個都沒有就是沒在跑。
//!
//! 磁碟是資料庫所在的分割區（容器裡的 /data volume，在 EC2 上就是根目錄那顆 EBS）。
//! 網路讀 1 號行程（主機的 init）的 /proc/1/net/dev，才是主機的網卡而不是容器的。
//!
//! 背景每 5 秒取樣一次。最近 1 小時的 5 秒點只放在記憶體；每分鐘的平均寫進資料庫（`monitor_points`，保留 7 天），
//! 24 小時和 7 天的圖從資料庫讀，換版重啟後也還在。換版時新舊兩個容器同時在取樣，分鐘點對齊到整分鐘，
//! 同一分鐘留取樣點多的那一筆。
//! 本機開發（Windows、macOS）沒有 /proc，頁面會顯示讀不到。

use std::{
    collections::{HashMap, VecDeque},
    fs, io,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    AppError, AppState,
    auth::{AdminUsers, Require},
};

const SAMPLE_EVERY: Duration = Duration::from_secs(5);
/// 1 小時的 5 秒點，只放在記憶體
const RECENT_POINTS: usize = 720;
const MINUTE_MS: i64 = 60_000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;
/// 每分鐘的平均在資料庫裡留多久，也是最長的圖
const KEEP_MS: i64 = 7 * DAY_MS;
/// 7 天的圖每 10 分鐘一點，約 1000 點
const WEEK_STEP_MS: i64 = 10 * MINUTE_MS;
/// 資料庫寫不進去時，最多先在記憶體留 1 小時的分鐘點
const MAX_PENDING: usize = 60;
const CLEANUP_EVERY: Duration = Duration::from_secs(60 * 60);
const MAX_CMD_LEN: usize = 200;
const MAX_TARGETS: i64 = 20;
const MAX_LABEL_LEN: usize = 40;
const MAX_PATTERN_LEN: usize = 100;

pub struct Monitor {
    proc_dir: PathBuf,
    /// 看這個資料夾所在分割區的用量，以及資料夾裡檔案的大小（資料庫）
    data_dir: PathBuf,
    inner: Mutex<Inner>,
}

impl Default for Monitor {
    fn default() -> Self {
        Self::new("/proc", "data")
    }
}

#[derive(Default)]
struct Inner {
    prev: Option<Counters>,
    latest: Option<Snapshot>,
    error: Option<String>,
    recent: VecDeque<Point>,
    /// 這一分鐘到目前為止的點，換到下一分鐘時平均成一點放進 pending
    minute: Vec<Point>,
    /// 平均好、還沒寫進資料庫的分鐘點
    pending: VecDeque<Minute>,
}

#[derive(Clone)]
struct Minute {
    /// t 是這一分鐘的開始
    point: Point,
    samples: usize,
}

/// 上一次取樣的累計值，這次減掉它才算得出速率
struct Counters {
    at: Instant,
    cpu: CpuTimes,
    net: Option<(u64, u64)>,
    disk: Option<(u64, u64)>,
    /// pid → (啟動時間, 累計 CPU ticks)；啟動時間不同表示 pid 被重複使用了
    procs: HashMap<u32, (u64, u64)>,
}

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    total: u64,
    idle: u64,
    iowait: u64,
    steal: u64,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    /// Unix 毫秒
    pub sampled_at: i64,
    pub kernel: String,
    pub cpu_model: String,
    pub cpus: usize,
    pub uptime_secs: u64,
    pub load: [f64; 3],
    /// 第一次取樣還沒有上一次可以比，是 null
    pub cpu: Option<CpuUsage>,
    pub memory: Memory,
    pub disk: Option<Disk>,
    pub disk_io: Option<DiskIo>,
    pub net: Option<Net>,
    /// 依記憶體由大到小
    pub groups: Vec<Group>,
}

/// 佔整台主機的百分比
#[derive(Clone, Copy, Serialize)]
pub struct CpuUsage {
    pub busy: f64,
    pub iowait: f64,
    /// 被虛擬化平台拿走的時間；EC2 的 t 系列 CPU credit 用完時會變高
    pub steal: f64,
}

#[derive(Clone, Serialize)]
pub struct Memory {
    pub total: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
}

#[derive(Clone, Serialize)]
pub struct Disk {
    pub total: u64,
    pub used: u64,
    /// 一般使用者還能用的（不含保留給 root 的部分），跟 df 一樣
    pub available: u64,
    /// 資料庫資料夾裡的檔案加起來
    pub data_bytes: u64,
}

#[derive(Clone, Copy, Serialize)]
pub struct DiskIo {
    pub read_bps: f64,
    pub write_bps: f64,
}

#[derive(Clone, Copy, Serialize)]
pub struct Net {
    pub rx_bps: f64,
    pub tx_bps: f64,
}

#[derive(Clone, Serialize)]
pub struct Group {
    /// `service`（systemd）、`container`（Docker）、`session`（登入的工作階段、tmux 等 scope）、
    /// `self`（這個網站自己的容器）、`other`
    pub kind: &'static str,
    /// 服務名稱、容器 id 前 12 碼或 scope 名稱
    pub name: String,
    /// 完整的 cgroup 路徑
    pub cgroup: String,
    pub cpu: f64,
    pub rss: u64,
    /// 最早的行程啟動的時間（Unix 秒），重開過就會變
    pub started_at: i64,
    /// 依記憶體由大到小
    pub processes: Vec<Process>,
}

#[derive(Clone, Serialize)]
pub struct Process {
    pub pid: u32,
    pub cmd: String,
    pub cpu: f64,
    pub rss: u64,
    pub threads: u32,
    pub started_at: i64,
}

#[derive(Clone, Serialize)]
pub struct Point {
    /// Unix 毫秒
    pub t: i64,
    pub cpu: f64,
    pub mem_used: u64,
    pub rx_bps: f64,
    pub tx_bps: f64,
    pub read_bps: f64,
    pub write_bps: f64,
    pub targets: Vec<TargetPoint>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TargetPoint {
    pub id: i64,
    pub cpu: f64,
    pub rss: u64,
    pub processes: f64,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Target {
    pub id: i64,
    pub label: String,
    pub pattern: String,
}

impl Monitor {
    pub fn new(proc_dir: impl Into<PathBuf>, data_dir: impl Into<PathBuf>) -> Self {
        Self { proc_dir: proc_dir.into(), data_dir: data_dir.into(), inner: Mutex::default() }
    }

    fn read(&self, path: &str) -> io::Result<String> {
        fs::read_to_string(self.proc_dir.join(path))
    }

    /// 取樣一次。背景每 5 秒呼叫；測試直接呼叫
    pub fn sample(&self, targets: &[Target]) -> io::Result<()> {
        self.sample_at(targets, Utc::now().timestamp_millis())
    }

    /// 當成在 `at`（Unix 毫秒）取樣，測試用來跨過整分鐘
    pub fn sample_at(&self, targets: &[Target], at: i64) -> io::Result<()> {
        let result = self.collect(targets, at);
        if let Err(err) = &result {
            self.inner.lock().unwrap().error = Some(format!("讀不到 {}：{err}", self.proc_dir.display()));
        }
        result
    }

    /// 把平均好的分鐘點寫進資料庫。背景每次取樣完呼叫；測試直接呼叫
    pub async fn flush(&self, pool: &SqlitePool) -> Result<(), sqlx::Error> {
        let minutes: Vec<Minute> = self.inner.lock().unwrap().pending.iter().cloned().collect();
        let Some(last) = minutes.last().map(|m| m.point.t) else { return Ok(()) };
        let mut tx = pool.begin().await?;
        for Minute { point: p, samples } in &minutes {
            sqlx::query(
                "INSERT INTO monitor_points (t, samples, cpu, mem_used, rx_bps, tx_bps, read_bps, write_bps, targets)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (t) DO UPDATE SET
                     samples = excluded.samples, cpu = excluded.cpu, mem_used = excluded.mem_used,
                     rx_bps = excluded.rx_bps, tx_bps = excluded.tx_bps,
                     read_bps = excluded.read_bps, write_bps = excluded.write_bps, targets = excluded.targets
                 WHERE excluded.samples > monitor_points.samples",
            )
            .bind(p.t)
            .bind(*samples as i64)
            .bind(p.cpu)
            .bind(p.mem_used as i64)
            .bind(p.rx_bps)
            .bind(p.tx_bps)
            .bind(p.read_bps)
            .bind(p.write_bps)
            .bind(serde_json::to_string(&p.targets).unwrap_or_else(|_| "[]".into()))
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        // 寫的期間又平均好的分鐘留著，下次再寫
        self.inner.lock().unwrap().pending.retain(|m| m.point.t > last);
        Ok(())
    }

    fn collect(&self, targets: &[Target], at: i64) -> io::Result<()> {
        let stat = self.read("stat")?;
        let meminfo = self.read("meminfo")?;
        let now = Instant::now();
        let cpu_times = parse_cpu_times(&stat);
        let boot_time = stat_field(&stat, "btime").unwrap_or(0);
        let memory = parse_meminfo(&meminfo);
        let net = self.read("1/net/dev").or_else(|_| self.read("net/dev")).ok().map(|text| parse_net_dev(&text));
        let disk_io = self.read("diskstats").ok().map(|text| parse_diskstats(&text));
        let raw = self.processes();

        let mut inner = self.inner.lock().unwrap();
        let prev = inner.prev.take();
        let elapsed = prev.as_ref().map(|p| now.duration_since(p.at).as_secs_f64()).filter(|s| *s > 0.0);
        let cpus = cpu_count(&stat).max(1);
        // 每個行程的 CPU 也換算成佔整台主機的百分比，和上面的總量能直接比
        let tick_share = |ticks: u64| match elapsed {
            Some(secs) => ticks as f64 / clock_ticks() as f64 / secs / cpus as f64 * 100.0,
            None => 0.0,
        };

        let cpu = prev.as_ref().map(|p| {
            let total = cpu_times.total.saturating_sub(p.cpu.total).max(1) as f64;
            let idle = cpu_times.idle.saturating_sub(p.cpu.idle) as f64;
            let iowait = cpu_times.iowait.saturating_sub(p.cpu.iowait) as f64;
            let steal = cpu_times.steal.saturating_sub(p.cpu.steal) as f64;
            CpuUsage {
                busy: ((total - idle - iowait) / total * 100.0).clamp(0.0, 100.0),
                iowait: iowait / total * 100.0,
                steal: steal / total * 100.0,
            }
        });
        let rate = |now: Option<(u64, u64)>, before: Option<(u64, u64)>| match (now, before, elapsed) {
            (Some(now), Some(before), Some(secs)) => {
                Some((now.0.saturating_sub(before.0) as f64 / secs, now.1.saturating_sub(before.1) as f64 / secs))
            }
            _ => None,
        };
        let net_rate = rate(net, prev.as_ref().and_then(|p| p.net)).map(|(rx, tx)| Net { rx_bps: rx, tx_bps: tx });
        let io_rate = rate(disk_io, prev.as_ref().and_then(|p| p.disk))
            .map(|(read, write)| DiskIo { read_bps: read, write_bps: write });

        let self_cgroup = self.read("self/cgroup").ok().map(|text| cgroup_path(&text));
        let mut groups: HashMap<String, Group> = HashMap::new();
        let mut counters = HashMap::with_capacity(raw.len());
        for p in raw {
            let ticks = p.utime + p.stime;
            let used = match prev.as_ref().and_then(|prev| prev.procs.get(&p.pid)) {
                Some(&(start, before)) if start == p.start_ticks => ticks.saturating_sub(before),
                _ => 0,
            };
            counters.insert(p.pid, (p.start_ticks, ticks));
            let started_at = (boot_time + p.start_ticks / clock_ticks()) as i64;
            let process =
                Process { pid: p.pid, cmd: p.cmd, cpu: tick_share(used), rss: p.rss, threads: p.threads, started_at };
            let group = groups.entry(p.cgroup.clone()).or_insert_with(|| {
                let (kind, name) = if self_cgroup.as_deref() == Some(p.cgroup.as_str()) {
                    ("self", String::new())
                } else {
                    classify(&p.cgroup)
                };
                Group { kind, name, cgroup: p.cgroup, cpu: 0.0, rss: 0, started_at, processes: Vec::new() }
            });
            group.cpu += process.cpu;
            group.rss += process.rss;
            group.started_at = group.started_at.min(started_at);
            group.processes.push(process);
        }
        let mut groups: Vec<Group> = groups.into_values().collect();
        for group in &mut groups {
            group.processes.sort_by(|a, b| b.rss.cmp(&a.rss));
        }
        groups.sort_by(|a, b| b.rss.cmp(&a.rss));

        let snapshot = Snapshot {
            sampled_at: at,
            kernel: self.read("sys/kernel/osrelease").map(|s| s.trim().to_owned()).unwrap_or_default(),
            cpu_model: self.read("cpuinfo").map(|s| parse_cpu_model(&s)).unwrap_or_default(),
            cpus,
            uptime_secs: self.read("uptime").ok().and_then(|s| parse_first_float(&s)).unwrap_or(0.0) as u64,
            load: self.read("loadavg").map(|s| parse_loadavg(&s)).unwrap_or_default(),
            cpu,
            memory,
            disk: disk_usage(&self.data_dir),
            disk_io: io_rate,
            net: net_rate,
            groups,
        };

        if let Some(cpu) = cpu {
            let point = Point {
                t: snapshot.sampled_at,
                cpu: cpu.busy,
                mem_used: snapshot.memory.total.saturating_sub(snapshot.memory.available),
                rx_bps: net_rate.map_or(0.0, |n| n.rx_bps),
                tx_bps: net_rate.map_or(0.0, |n| n.tx_bps),
                read_bps: io_rate.map_or(0.0, |d| d.read_bps),
                write_bps: io_rate.map_or(0.0, |d| d.write_bps),
                targets: targets
                    .iter()
                    .map(|target| {
                        let status = target_status(target, &snapshot.groups);
                        TargetPoint {
                            id: target.id,
                            cpu: status.cpu,
                            rss: status.rss,
                            processes: status.processes as f64,
                        }
                    })
                    .collect(),
            };
            push_capped(&mut inner.recent, point.clone(), RECENT_POINTS);
            // 換到下一分鐘了：上一分鐘的點平均起來等著寫進資料庫
            if inner.minute.first().is_some_and(|first| floor_to(first.t, MINUTE_MS) != floor_to(point.t, MINUTE_MS)) {
                let points = std::mem::take(&mut inner.minute);
                let minute =
                    Minute { point: average(&points, floor_to(points[0].t, MINUTE_MS)), samples: points.len() };
                push_capped(&mut inner.pending, minute, MAX_PENDING);
            }
            inner.minute.push(point);
        }

        inner.prev = Some(Counters { at: now, cpu: cpu_times, net, disk: disk_io, procs: counters });
        inner.latest = Some(snapshot);
        inner.error = None;
        Ok(())
    }

    fn processes(&self) -> Vec<RawProcess> {
        let page = page_size();
        let Ok(entries) = fs::read_dir(&self.proc_dir) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| {
                let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
                let dir = entry.path();
                // 行程可能在讀到一半時結束，讀不到就跳過
                let stat = fs::read_to_string(dir.join("stat")).ok()?;
                let cmdline = fs::read(dir.join("cmdline")).ok()?;
                // kernel thread 沒有指令列，也不佔使用者的記憶體，不列
                if cmdline.is_empty() {
                    return None;
                }
                let cgroup = fs::read_to_string(dir.join("cgroup")).map(|s| cgroup_path(&s)).unwrap_or_default();
                parse_process(pid, &stat, &cmdline, cgroup, page)
            })
            .collect()
    }
}

fn push_capped<T>(queue: &mut VecDeque<T>, item: T, cap: usize) {
    if queue.len() >= cap {
        queue.pop_front();
    }
    queue.push_back(item);
}

/// 對齊到 `step` 毫秒的整數倍，例如整分鐘
fn floor_to(t: i64, step: i64) -> i64 {
    t - t.rem_euclid(step)
}

/// 依時間每 `step` 毫秒平均成一點，t 是那一段的開始（點要依時間排好）
fn downsample(points: Vec<Point>, step: i64) -> Vec<Point> {
    let mut out = Vec::new();
    let mut bucket: Vec<Point> = Vec::new();
    for point in points {
        if bucket.first().is_some_and(|first| floor_to(first.t, step) != floor_to(point.t, step)) {
            out.push(average(&bucket, floor_to(bucket[0].t, step)));
            bucket.clear();
        }
        bucket.push(point);
    }
    if let Some(first) = bucket.first() {
        out.push(average(&bucket, floor_to(first.t, step)));
    }
    out
}

/// 一段時間裡的點平均成時間是 `t` 的一點；監控目標用 id 對齊（中途新增的只平均有出現的點）
fn average(points: &[Point], t: i64) -> Point {
    let n = points.len().max(1) as f64;
    let mean = |f: fn(&Point) -> f64| points.iter().map(f).sum::<f64>() / n;
    let mut targets: Vec<(TargetPoint, f64)> = Vec::new();
    for point in points {
        for t in &point.targets {
            match targets.iter_mut().find(|(sum, _)| sum.id == t.id) {
                Some((sum, count)) => {
                    sum.cpu += t.cpu;
                    sum.rss += t.rss;
                    sum.processes += t.processes;
                    *count += 1.0;
                }
                None => targets.push((t.clone(), 1.0)),
            }
        }
    }
    Point {
        t,
        cpu: mean(|p| p.cpu),
        mem_used: mean(|p| p.mem_used as f64) as u64,
        rx_bps: mean(|p| p.rx_bps),
        tx_bps: mean(|p| p.tx_bps),
        read_bps: mean(|p| p.read_bps),
        write_bps: mean(|p| p.write_bps),
        targets: targets
            .into_iter()
            .map(|(sum, count)| TargetPoint {
                id: sum.id,
                cpu: sum.cpu / count,
                rss: (sum.rss as f64 / count) as u64,
                processes: sum.processes / count,
            })
            .collect(),
    }
}

// ---- 解析 /proc ----

struct RawProcess {
    pid: u32,
    cmd: String,
    cgroup: String,
    utime: u64,
    stime: u64,
    threads: u32,
    start_ticks: u64,
    rss: u64,
}

/// `/proc/<pid>/stat`：`pid (comm) state ppid ...`，comm 可能有空白和括號，所以從最後一個 `)` 往後切
fn parse_process(pid: u32, stat: &str, cmdline: &[u8], cgroup: String, page: u64) -> Option<RawProcess> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // fields[0] 是第 3 欄（state），第 n 欄是 fields[n - 3]
    let field = |n: usize| fields.get(n - 3).and_then(|v| v.parse::<u64>().ok());
    let cmd: String = String::from_utf8_lossy(cmdline)
        .split('\0')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_CMD_LEN)
        .collect();
    Some(RawProcess {
        pid,
        cmd,
        cgroup,
        utime: field(14)?,
        stime: field(15)?,
        threads: field(20)? as u32,
        start_ticks: field(22)?,
        rss: field(24)? * page,
    })
}

/// `/proc/<pid>/cgroup` 裡的路徑：cgroup v2 是 `0::/system.slice/foo.service`；
/// v1 有很多行，取 systemd 那一行。在容器自己的 cgroup namespace 裡看，外面的路徑會以 `/..` 開頭
fn cgroup_path(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let line = lines
        .iter()
        .find(|l| l.starts_with("0::"))
        .or_else(|| lines.iter().find(|l| l.contains(":name=systemd:")))
        .or(lines.first());
    line.and_then(|l| l.splitn(3, ':').nth(2)).unwrap_or_default().trim().to_owned()
}

/// 從 cgroup 路徑最裡面那層往外找認得的名稱
fn classify(path: &str) -> (&'static str, String) {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty() && *p != "..").collect();
    for (i, part) in parts.iter().enumerate().rev() {
        if let Some(id) = part.strip_prefix("docker-").and_then(|p| p.strip_suffix(".scope")) {
            return ("container", id.chars().take(12).collect());
        }
        // cgroupfs driver：/docker/<id>
        if i > 0 && parts[i - 1] == "docker" {
            return ("container", part.chars().take(12).collect());
        }
        if let Some(name) = part.strip_suffix(".service") {
            return ("service", name.to_owned());
        }
        if let Some(name) = part.strip_suffix(".scope") {
            return ("session", name.to_owned());
        }
    }
    ("other", path.to_owned())
}

fn parse_cpu_times(stat: &str) -> CpuTimes {
    let Some(line) = stat.lines().find(|l| l.starts_with("cpu ")) else { return CpuTimes::default() };
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|n| n.parse().ok()).collect();
    let at = |i: usize| v.get(i).copied().unwrap_or(0);
    // user nice system idle iowait irq softirq steal guest guest_nice；guest 已經算在 user 裡
    CpuTimes { total: (0..8).map(at).sum(), idle: at(3), iowait: at(4), steal: at(7) }
}

fn cpu_count(stat: &str) -> usize {
    stat.lines().filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(u8::is_ascii_digit)).count()
}

fn stat_field(stat: &str, name: &str) -> Option<u64> {
    stat.lines().find_map(|l| l.strip_prefix(name)?.trim().parse().ok())
}

fn parse_meminfo(text: &str) -> Memory {
    let kb = |name: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(name)?.strip_prefix(':')?.split_whitespace().next()?.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    Memory {
        total: kb("MemTotal"),
        available: kb("MemAvailable"),
        swap_total: kb("SwapTotal"),
        swap_free: kb("SwapFree"),
    }
}

fn parse_cpu_model(text: &str) -> String {
    text.lines()
        .find_map(|l| {
            let (key, value) = l.split_once(':')?;
            (key.trim() == "model name").then(|| value.trim().to_owned())
        })
        .unwrap_or_default()
}

fn parse_first_float(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

fn parse_loadavg(text: &str) -> [f64; 3] {
    let mut load = [0.0; 3];
    for (slot, value) in load.iter_mut().zip(text.split_whitespace()) {
        *slot = value.parse().unwrap_or(0.0);
    }
    load
}

/// 實體網卡收送的位元組總和；docker 的虛擬網卡（docker0、veth、br-）是主機內部的流量，不算
fn parse_net_dev(text: &str) -> (u64, u64) {
    let mut total = (0, 0);
    for line in text.lines().skip(2) {
        let Some((name, values)) = line.split_once(':') else { continue };
        let name = name.trim();
        if name == "lo" || ["docker", "veth", "br-", "virbr"].iter().any(|p| name.starts_with(p)) {
            continue;
        }
        let v: Vec<u64> = values.split_whitespace().filter_map(|n| n.parse().ok()).collect();
        total.0 += v.first().copied().unwrap_or(0);
        total.1 += v.get(8).copied().unwrap_or(0);
    }
    total
}

/// 整顆磁碟（不含分割區、loop、ram）讀寫的位元組總和；sector 固定是 512 bytes
fn parse_diskstats(text: &str) -> (u64, u64) {
    let mut total = (0, 0);
    for line in text.lines() {
        let v: Vec<&str> = line.split_whitespace().collect();
        let Some(name) = v.get(2) else { continue };
        if !is_whole_disk(name) {
            continue;
        }
        let sectors = |i: usize| v.get(i).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
        total.0 += sectors(5) * 512;
        total.1 += sectors(9) * 512;
    }
    total
}

fn is_whole_disk(name: &str) -> bool {
    // EC2 的 EBS 是 nvme0n1（分割區是 nvme0n1p1），舊機型是 xvda（分割區是 xvda1）
    if let Some(rest) = name.strip_prefix("nvme") {
        return !rest.contains('p');
    }
    ["xvd", "sd", "vd"].iter().any(|prefix| {
        name.strip_prefix(prefix).is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase()))
    })
}

#[cfg(unix)]
fn disk_usage(dir: &FsPath) -> Option<Disk> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs 只寫進傳進去的 struct，path 是 NUL 結尾的字串
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let block = u64::from(stat.f_frsize);
    let total = u64::from(stat.f_blocks) * block;
    let free = u64::from(stat.f_bfree) * block;
    Some(Disk { total, used: total - free, available: u64::from(stat.f_bavail) * block, data_bytes: dir_size(dir) })
}

#[cfg(not(unix))]
fn disk_usage(_dir: &FsPath) -> Option<Disk> {
    None
}

#[cfg(unix)]
fn dir_size(dir: &FsPath) -> u64 {
    fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
}

#[cfg(unix)]
fn clock_ticks() -> u64 {
    // SAFETY: sysconf 沒有副作用
    u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|&n| n > 0).unwrap_or(100)
}

#[cfg(not(unix))]
fn clock_ticks() -> u64 {
    100
}

#[cfg(unix)]
fn page_size() -> u64 {
    // SAFETY: sysconf 沒有副作用
    u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok().filter(|&n| n > 0).unwrap_or(4096)
}

#[cfg(not(unix))]
fn page_size() -> u64 {
    4096
}

// ---- 監控清單 ----

#[derive(Serialize)]
pub struct TargetStatus {
    pub id: i64,
    pub label: String,
    pub pattern: String,
    pub processes: usize,
    pub cpu: f64,
    pub rss: u64,
    /// 最早的行程啟動的時間（Unix 秒）；沒在跑是 null
    pub started_at: Option<i64>,
}

/// cgroup 路徑或指令列含有關鍵字（不分大小寫）的行程都算這個目標的
fn target_status(target: &Target, groups: &[Group]) -> TargetStatus {
    let pattern = target.pattern.to_lowercase();
    let mut status = TargetStatus {
        id: target.id,
        label: target.label.clone(),
        pattern: target.pattern.clone(),
        processes: 0,
        cpu: 0.0,
        rss: 0,
        started_at: None,
    };
    for group in groups {
        let whole = group.cgroup.to_lowercase().contains(&pattern);
        for p in &group.processes {
            if whole || p.cmd.to_lowercase().contains(&pattern) {
                status.processes += 1;
                status.cpu += p.cpu;
                status.rss += p.rss;
                status.started_at = Some(status.started_at.map_or(p.started_at, |s| s.min(p.started_at)));
            }
        }
    }
    status
}

async fn load_targets(pool: &SqlitePool) -> Result<Vec<Target>, sqlx::Error> {
    sqlx::query_as("SELECT id, label, pattern FROM monitor_targets ORDER BY id").fetch_all(pool).await
}

/// `monitor_points` 的一列：t、cpu、mem_used、rx_bps、tx_bps、read_bps、write_bps、targets（JSON）
type PointRow = (i64, f64, i64, f64, f64, f64, f64, String);

/// 資料庫裡 `since`（Unix 毫秒）之後的分鐘點，依時間排好
async fn stored_minutes(pool: &SqlitePool, since: i64) -> Result<Vec<Point>, sqlx::Error> {
    let rows: Vec<PointRow> = sqlx::query_as(
        "SELECT t, cpu, mem_used, rx_bps, tx_bps, read_bps, write_bps, targets
         FROM monitor_points WHERE t >= ? ORDER BY t",
    )
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(t, cpu, mem_used, rx_bps, tx_bps, read_bps, write_bps, targets)| Point {
            t,
            cpu,
            mem_used: mem_used.max(0) as u64,
            rx_bps,
            tx_bps,
            read_bps,
            write_bps,
            // 解不開就當成沒有監控目標，主機的線照樣畫得出來
            targets: serde_json::from_str(&targets).unwrap_or_default(),
        })
        .collect())
}

/// 背景每 5 秒取樣一次，平均好的分鐘點接著寫進資料庫，每小時清掉超過 7 天的
pub fn spawn(monitor: Arc<Monitor>, pool: SqlitePool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SAMPLE_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut warned = false;
        let mut cleaned_at: Option<Instant> = None;
        loop {
            tick.tick().await;
            let targets = load_targets(&pool).await.unwrap_or_default();
            let sampler = monitor.clone();
            match tokio::task::spawn_blocking(move || sampler.sample(&targets)).await {
                Ok(Ok(())) => warned = false,
                // 本機開發沒有 /proc，只警告一次
                Ok(Err(err)) if !warned => {
                    warned = true;
                    tracing::warn!(error = %err, "failed to read /proc for host monitor");
                }
                Ok(Err(_)) => {}
                Err(err) => tracing::warn!(error = %err, "host monitor sampling panicked"),
            }
            if let Err(err) = monitor.flush(&pool).await {
                tracing::warn!(error = %err, "failed to save host monitor history");
            }
            if cleaned_at.is_none_or(|at| at.elapsed() >= CLEANUP_EVERY) {
                cleaned_at = Some(Instant::now());
                let deleted = sqlx::query("DELETE FROM monitor_points WHERE t < ?")
                    .bind(Utc::now().timestamp_millis() - KEEP_MS)
                    .execute(&pool)
                    .await;
                if let Err(err) = deleted {
                    tracing::warn!(error = %err, "failed to clean up host monitor history");
                }
            }
        }
    });
}

// ---- API ----

#[derive(Serialize)]
pub struct StatusReply {
    /// 還沒取樣過或讀不到 /proc 是 null，原因在 error
    pub snapshot: Option<Snapshot>,
    pub error: Option<String>,
    pub targets: Vec<TargetStatus>,
}

pub async fn status(
    Require(_, _): Require<AdminUsers>,
    State(state): State<AppState>,
) -> Result<Json<StatusReply>, AppError> {
    let targets = load_targets(&state.pool).await?;
    let inner = state.monitor.inner.lock().unwrap();
    let groups = inner.latest.as_ref().map_or(&[][..], |s| &s.groups[..]);
    Ok(Json(StatusReply {
        targets: targets.iter().map(|t| target_status(t, groups)).collect(),
        snapshot: inner.latest.clone(),
        error: inner.error.clone(),
    }))
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    /// `1h`（每 5 秒一點，預設）、`24h`（每分鐘一點）或 `7d`（每 10 分鐘一點）
    #[serde(default)]
    pub range: String,
}

#[derive(Serialize)]
pub struct HistoryReply {
    pub step_secs: u64,
    pub points: Vec<Point>,
}

pub async fn history(
    Require(_, _): Require<AdminUsers>,
    State(state): State<AppState>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryReply>, AppError> {
    let (span, step) = match query.range.as_str() {
        "7d" => (KEEP_MS, WEEK_STEP_MS),
        "24h" => (DAY_MS, MINUTE_MS),
        _ => (HOUR_MS, SAMPLE_EVERY.as_millis() as i64),
    };
    let since = Utc::now().timestamp_millis() - span;
    // 先複製記憶體裡的，鎖不能跨過下面的資料庫查詢
    let (recent, unsaved) = {
        let inner = state.monitor.inner.lock().unwrap();
        let mut unsaved: Vec<Point> = inner.pending.iter().map(|m| m.point.clone()).collect();
        // 還沒過完的這一分鐘也平均起來接在最後
        if let Some(first) = inner.minute.first() {
            unsaved.push(average(&inner.minute, floor_to(first.t, MINUTE_MS)));
        }
        let recent: Vec<Point> = if span == HOUR_MS { inner.recent.iter().cloned().collect() } else { Vec::new() };
        (recent, unsaved)
    };
    let mut minutes = stored_minutes(&state.pool, since).await?;
    // 複製之後才寫進去的分鐘兩邊都有，只接比資料庫新的
    let last = minutes.last().map_or(i64::MIN, |p| p.t);
    minutes.extend(unsaved.into_iter().filter(|p| p.t > last && p.t >= since));

    let points = match span {
        KEEP_MS => downsample(minutes, WEEK_STEP_MS),
        DAY_MS => minutes,
        _ => {
            // 以記憶體裡的 5 秒點為主；剛重啟還不滿 1 小時的部分，用資料庫的分鐘點補在前面
            let first = recent.first().map_or(i64::MAX, |p| p.t);
            let mut points: Vec<Point> = minutes.into_iter().filter(|p| p.t + MINUTE_MS <= first).collect();
            points.extend(recent);
            points
        }
    };
    Ok(Json(HistoryReply { step_secs: (step / 1000) as u64, points }))
}

#[derive(Deserialize)]
pub struct NewTarget {
    pub label: String,
    pub pattern: String,
}

pub async fn create_target(
    Require(_, _): Require<AdminUsers>,
    State(state): State<AppState>,
    Json(input): Json<NewTarget>,
) -> Result<(StatusCode, Json<Target>), AppError> {
    let label = input.label.trim();
    let pattern = input.pattern.trim();
    if label.is_empty() || pattern.is_empty() {
        return Err(AppError::BadRequest("名稱和關鍵字都要填".into()));
    }
    if label.chars().count() > MAX_LABEL_LEN || pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(AppError::BadRequest(format!("名稱最多 {MAX_LABEL_LEN} 字、關鍵字最多 {MAX_PATTERN_LEN} 字")));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM monitor_targets").fetch_one(&state.pool).await?;
    if count >= MAX_TARGETS {
        return Err(AppError::BadRequest(format!("監控清單最多 {MAX_TARGETS} 個")));
    }
    let target =
        sqlx::query_as("INSERT INTO monitor_targets (label, pattern) VALUES (?, ?) RETURNING id, label, pattern")
            .bind(label)
            .bind(pattern)
            .fetch_one(&state.pool)
            .await?;
    Ok((StatusCode::CREATED, Json(target)))
}

pub async fn delete_target(
    Require(_, _): Require<AdminUsers>,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = sqlx::query("DELETE FROM monitor_targets WHERE id = ?").bind(id).execute(&state.pool).await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_process_stat_with_spaces_in_name() {
        let stat = "1234 (my (bot) x) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 7 0 9000 123456 300 18446744073709551615";
        let p =
            parse_process(1234, stat, b"python3\0bot.py\0--fast\0", "/system.slice/bot.service".into(), 4096).unwrap();
        assert_eq!((p.utime, p.stime, p.threads, p.start_ticks, p.rss), (250, 50, 7, 9000, 300 * 4096));
        assert_eq!(p.cmd, "python3 bot.py --fast");
    }

    #[test]
    fn classifies_cgroups() {
        assert_eq!(classify("/system.slice/wb-relay.service"), ("service", "wb-relay".into()));
        assert_eq!(
            classify("/../system.slice/docker-0123456789abcdef0123456789abcdef.scope"),
            ("container", "0123456789ab".into())
        );
        assert_eq!(classify("/docker/0123456789abcdef"), ("container", "0123456789ab".into()));
        assert_eq!(
            classify("/user.slice/user-1000.slice/user@1000.service/app.slice/xiao-xia.service"),
            ("service", "xiao-xia".into())
        );
        assert_eq!(classify("/user.slice/user-1000.slice/session-3.scope"), ("session", "session-3".into()));
        assert_eq!(cgroup_path("0::/system.slice/ssh.service\n"), "/system.slice/ssh.service");
        assert_eq!(
            cgroup_path("12:pids:/a\n1:name=systemd:/system.slice/cron.service\n"),
            "/system.slice/cron.service"
        );
    }

    #[test]
    fn counts_only_whole_disks_and_real_nics() {
        assert!(is_whole_disk("nvme0n1") && is_whole_disk("xvda") && is_whole_disk("sda"));
        assert!(!is_whole_disk("nvme0n1p1") && !is_whole_disk("xvda1") && !is_whole_disk("loop0"));
        let net = "Inter-|   Receive\n face |bytes\n    lo: 999 0 0 0 0 0 0 0 999 0\n  ens5: 1000 5 0 0 0 0 0 0 2000 3\nveth12: 50 0 0 0 0 0 0 0 60 0\n";
        assert_eq!(parse_net_dev(net), (1000, 2000));
    }
}
