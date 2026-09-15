/**
 * 重复规则引擎 —— Twische 的"固定时间任务"排期内核。
 *
 * 设计取舍：
 * 1. 采用 RFC 5545 (iCalendar RRULE) 的子集，语义与其保持一致，这样"2 月没有 30 号
 *    就跳过"这类行为不需要自创规则，直接对齐国际标准。
 * 2. **墙钟语义优先**（Wall-clock semantics）：23:00–01:00 永远指本地的 23:00–01:00，
 *    即使中间跨过夏令时切换。因此绝不用"毫秒加减"来推进日程，一律用日历分量构造
 *    Date，把 DST 交给运行时按本地时区规则处理。
 * 3. 所有展开循环都有硬上限，宁可少展开也不能挂死主线程。
 */

/** 单个规则最多扫描多少个周期（约等于 137 年的按日规则），防死循环。 */
export const MAX_PERIODS = 50000;
/** 单次查询最多返回多少个发生实例。 */
export const MAX_OCCURRENCES = 5000;

const MINUTE = 60000;

// ───────────────────────────── 时间基元 ─────────────────────────────

/**
 * 'HH:mm' → 从 00:00 起算的分钟数；非法输入返回 null（不抛异常，便于表单校验）。
 *
 * 只接受 00:00–23:59。**跨午夜一律用 `endTime <= startTime` 表达**，不接受 "24:30"
 * 这类写法 —— 同一种语义若有两种编码，同步合并时就会产生无法判定等价的记录。
 */
export function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 分钟数 → 规范化的 'HH:mm'（对超过一天的值回绕）。用于把计算/兜底结果收进合法域。 */
export function formatHHMM(minutes) {
  const n = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 分钟数 → 中文可读时长，如 "1 小时 30 分钟"。 */
export function formatDuration(minutes) {
  const n = Math.max(0, Math.round(minutes));
  if (n === 0) return '0 分钟';
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

/** 'YYYY-MM-DD' → {y,m,d}；非法返回 null。 */
export function parseDateKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (d > daysInMonth(y, mo)) return null; // 拒绝 2025-02-30
  return { y, m: mo, d };
}

/** Date → 'YYYY-MM-DD'（本地时区）。 */
export function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** 某年某月的天数。月份从 1 开始。 */
export function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** ISO 星期：周一=1 … 周日=7。 */
export function isoWeekday(date) {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

/** 在日期键上加减天数（自动跨月跨年），返回新的日期键。 */
export function addDays(dateKey, delta) {
  const p = parseDateKey(dateKey);
  if (!p) return null;
  const dt = new Date(p.y, p.m - 1, p.d + delta);
  return toDateKey(dt);
}

/** 按日历分量构造本地时间；minutes 允许 >= 1440 或为负，自动跨日。 */
export function localAt(dateKey, minutes) {
  const p = parseDateKey(dateKey);
  if (!p) return null;
  const dayOffset = Math.floor(minutes / 1440);
  const within = minutes - dayOffset * 1440;
  return new Date(p.y, p.m - 1, p.d + dayOffset, Math.floor(within / 60), within % 60, 0, 0);
}

/** 两个日期键之间相差的天数（b - a）。 */
export function daysBetween(a, b) {
  const pa = parseDateKey(a);
  const pb = parseDateKey(b);
  if (!pa || !pb) return NaN;
  const ta = new Date(pa.y, pa.m - 1, pa.d).getTime();
  const tb = new Date(pb.y, pb.m - 1, pb.d).getTime();
  return Math.round((tb - ta) / 86400000);
}

/**
 * 本地时间字符串 → Date。
 * 接受 'YYYY-MM-DDTHH:mm'（精确到分钟，这是 Twische 的最小粒度）。
 */
export function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const dk = parseDateKey(m[1]);
  if (!dk) return null;
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (h > 23 || mi > 59) return null;
  return new Date(dk.y, dk.m - 1, dk.d, h, mi, 0, 0);
}

/** Date → 'YYYY-MM-DDTHH:mm'（本地），Twische 里所有"精确到分钟"的存储格式。 */
export function toLocalDateTime(date) {
  return `${toDateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

// ───────────────────────────── 规则规范化 ─────────────────────────────

/** 默认规则，避免各处散落 `?? 1`。 */
export function defaultRecurrence() {
  return {
    freq: 'weekly',
    interval: 1,
    byWeekday: [],
    byMonthday: [],
    byMonth: [],
    nthWeekday: null, // { ordinal: 1..4 | -1, weekday: 1..7 } —— "每月第三个周五"
    startTime: '09:00',
    endTime: '10:00',
    dtstart: toDateKey(new Date()),
    until: null,
    count: null,
    exdates: [],
  };
}

/**
 * 清洗外部传入的规则。策略：**能修的静默修好，修不了的标出来**——
 * 表单每敲一个字都会调用它，不能因为中间态就报错。
 */
export function normalizeRecurrence(input) {
  const r = { ...defaultRecurrence(), ...(input || {}) };
  const issues = [];

  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq)) {
    issues.push(`未知的重复频率「${r.freq}」，已回退为每周`);
    r.freq = 'weekly';
  }

  const iv = Math.floor(Number(r.interval));
  if (!Number.isFinite(iv) || iv < 1) {
    r.interval = 1;
  } else {
    r.interval = Math.min(iv, 99); // 上限防止 UI 造出天文数字
  }

  r.byWeekday = sanitizeIntList(r.byWeekday, 1, 7);
  r.byMonthday = sanitizeIntList(r.byMonthday, 1, 31);
  r.byMonth = sanitizeIntList(r.byMonth, 1, 12);
  r.exdates = Array.isArray(r.exdates)
    ? [...new Set(r.exdates.filter((d) => parseDateKey(d) !== null))].sort()
    : [];

  if (r.nthWeekday && typeof r.nthWeekday === 'object') {
    const ordinal = Number(r.nthWeekday.ordinal);
    const weekday = Number(r.nthWeekday.weekday);
    const okOrdinal = [1, 2, 3, 4, -1].includes(ordinal);
    const okWeekday = Number.isInteger(weekday) && weekday >= 1 && weekday <= 7;
    r.nthWeekday = okOrdinal && okWeekday ? { ordinal, weekday } : null;
  } else {
    r.nthWeekday = null;
  }

  const st = parseHHMM(r.startTime);
  const et = parseHHMM(r.endTime);
  r.startTime = st === null ? '09:00' : formatHHMM(st);
  r.endTime = et === null ? formatHHMM((st === null ? 540 : st) + 60) : formatHHMM(et);

  if (!parseDateKey(r.dtstart)) r.dtstart = toDateKey(new Date());
  if (r.until !== null && r.until !== undefined && !parseDateKey(r.until)) r.until = null;
  if (r.until && r.until < r.dtstart) {
    issues.push('结束日期早于开始日期，已忽略结束日期');
    r.until = null;
  }

  const cnt = r.count === null || r.count === undefined ? null : Math.floor(Number(r.count));
  r.count = cnt !== null && Number.isFinite(cnt) && cnt > 0 ? Math.min(cnt, 9999) : null;

  if (r.freq === 'weekly' && r.byWeekday.length === 0) {
    // 每周但没选星期几 → 用起始日那天的星期，符合直觉
    const p = parseDateKey(r.dtstart);
    r.byWeekday = [isoWeekday(new Date(p.y, p.m - 1, p.d))];
  }
  if (r.freq === 'monthly' && !r.nthWeekday && r.byMonthday.length === 0) {
    r.byMonthday = [parseDateKey(r.dtstart).d];
  }
  if (r.freq === 'yearly') {
    const p = parseDateKey(r.dtstart);
    if (r.byMonth.length === 0) r.byMonth = [p.m];
    if (r.byMonthday.length === 0) r.byMonthday = [p.d];
  }

  return { rule: r, issues };
}

function sanitizeIntList(list, min, max) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const raw of list) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= min && n <= max) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// ───────────────────────────── 周期展开 ─────────────────────────────

/**
 * 生成规则在 [fromKey, toKey] 区间内的所有归属日期（尚未套用 count/until/exdate）。
 * 返回按时间升序的日期键数组。**不含去重后的最终过滤**，由 expandOccurrences 统一处理。
 */
function enumerateDateKeys(rule, fromKey, toKey) {
  const keys = [];
  const dtstart = rule.dtstart;
  const ds = parseDateKey(dtstart);
  const dsDate = new Date(ds.y, ds.m - 1, ds.d);
  let periods = 0;

  const pushIfInRange = (key) => {
    if (key < dtstart) return; // dtstart 之前不算
    if (key > toKey) return;
    if (key >= fromKey) keys.push(key);
  };

  if (rule.freq === 'daily') {
    // 锚定到 dtstart，按 interval 天推进
    const gap = Math.max(0, daysBetween(dtstart, fromKey));
    const step = Math.floor(gap / rule.interval) * rule.interval;
    let cursor = step;
    for (;;) {
      if (periods++ > MAX_PERIODS) break;
      const key = addDays(dtstart, cursor);
      if (!key || key > toKey) break;
      pushIfInRange(key);
      cursor += rule.interval;
    }
    return keys;
  }

  if (rule.freq === 'weekly') {
    // 周锚点：dtstart 所在周的周一（用周一为周首，与 ISO 一致）
    const anchorMonday = addDays(dtstart, -(isoWeekday(dsDate) - 1));
    const gapWeeks = Math.max(0, Math.floor(daysBetween(anchorMonday, fromKey) / 7));
    let week = Math.floor(gapWeeks / rule.interval) * rule.interval;
    for (;;) {
      if (periods++ > MAX_PERIODS) break;
      const monday = addDays(anchorMonday, week * 7);
      if (!monday || monday > toKey) break;
      for (const wd of rule.byWeekday) {
        const key = addDays(monday, wd - 1);
        if (key) pushIfInRange(key);
      }
      week += rule.interval;
    }
    return keys;
  }

  if (rule.freq === 'monthly') {
    const monthsSince = (a, b) => {
      const pa = parseDateKey(a);
      const pb = parseDateKey(b);
      return (pb.y - pa.y) * 12 + (pb.m - pa.m);
    };
    const gap = Math.max(0, monthsSince(dtstart, fromKey));
    let monthIdx = Math.floor(gap / rule.interval) * rule.interval;
    for (;;) {
      if (periods++ > MAX_PERIODS) break;
      const total = ds.m - 1 + monthIdx;
      const y = ds.y + Math.floor(total / 12);
      const m = (total % 12) + 1;
      const firstKey = `${y}-${String(m).padStart(2, '0')}-01`;
      if (firstKey > toKey) break;

      if (rule.nthWeekday) {
        const key = nthWeekdayOfMonth(y, m, rule.nthWeekday.ordinal, rule.nthWeekday.weekday);
        if (key) pushIfInRange(key);
      } else {
        const dim = daysInMonth(y, m);
        for (const day of rule.byMonthday) {
          if (day > dim) continue; // 2 月没有 30 号 → 跳过，与 RFC 5545 一致
          pushIfInRange(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
        }
      }
      monthIdx += rule.interval;
    }
    return keys;
  }

  // yearly
  let yearIdx = 0;
  const fromYear = parseDateKey(fromKey).y;
  if (fromYear > ds.y) {
    yearIdx = Math.floor((fromYear - ds.y) / rule.interval) * rule.interval;
  }
  for (;;) {
    if (periods++ > MAX_PERIODS) break;
    const y = ds.y + yearIdx;
    if (`${y}-01-01` > toKey) break;
    for (const m of rule.byMonth) {
      const dim = daysInMonth(y, m);
      for (const day of rule.byMonthday) {
        if (day > dim) continue; // 闰年 2/29 只在闰年出现
        pushIfInRange(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      }
    }
    yearIdx += rule.interval;
  }
  return keys;
}

/** 某月第 ordinal 个星期 weekday；ordinal = -1 表示最后一个。 */
export function nthWeekdayOfMonth(year, month, ordinal, weekday) {
  const dim = daysInMonth(year, month);
  const at = (day) => isoWeekday(new Date(year, month - 1, day));
  if (ordinal === -1) {
    for (let d = dim; d >= dim - 6; d--) {
      if (at(d) === weekday) return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  }
  let seen = 0;
  for (let d = 1; d <= dim; d++) {
    if (at(d) === weekday) {
      seen++;
      if (seen === ordinal) {
        return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }
  return null; // 该月没有第 5 个周五 → 跳过
}

// ───────────────────────────── 对外主入口 ─────────────────────────────

/**
 * 展开一个任务在指定区间内的所有发生实例。
 *
 * @param {object} task           任务记录（含 kind / recurrence / dueAt）
 * @param {string} fromKey        区间起始日期 'YYYY-MM-DD'（含）
 * @param {string} toKey          区间结束日期 'YYYY-MM-DD'（含）
 * @param {{completions?: Map<string,object>, limit?: number}} [opts]
 * @returns {Array<object>} 升序排列的发生实例
 */
export function expandOccurrences(task, fromKey, toKey, opts = {}) {
  const limit = Math.min(opts.limit ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const completions = opts.completions || new Map();
  const out = [];

  if (!task || !parseDateKey(fromKey) || !parseDateKey(toKey) || toKey < fromKey) return out;
  if (task.status === 'archived') return out;

  if (task.kind === 'deadline') {
    const due = parseLocalDateTime(task.dueAt);
    if (!due) return out;
    const key = toDateKey(due);
    // 截止任务只产生一个实例；是否落在区间内由"截止日"决定
    if (key < fromKey || key > toKey) return out;
    const iso = toLocalDateTime(due);
    const done = completions.get(`${task.id}|${iso}`);
    out.push({
      taskId: task.id,
      kind: 'deadline',
      key: iso,
      dateKey: key,
      allDay: !!task.allDay,
      startMinutes: due.getHours() * 60 + due.getMinutes(),
      endMinutes: due.getHours() * 60 + due.getMinutes(),
      durationMinutes: 0,
      startAt: due,
      endAt: due,
      dueAt: due,
      spansMidnight: false,
      overdue: !done && due.getTime() < Date.now(),
      done: !!done,
      completion: done || null,
    });
    return out;
  }

  // 固定时段任务
  const { rule } = normalizeRecurrence(task.recurrence);
  const startMin = parseHHMM(rule.startTime) ?? 540;
  let endMin = parseHHMM(rule.endTime) ?? startMin + 60;
  let duration = endMin - startMin;
  if (duration <= 0) duration += 1440; // 跨午夜：23:00 → 01:00
  const spansMidnight = endMin <= startMin;

  const exSet = new Set(rule.exdates);
  let keys = enumerateDateKeys(rule, fromKey, toKey).filter((k) => !exSet.has(k));
  keys = [...new Set(keys)].sort();

  // until 上界
  if (rule.until) keys = keys.filter((k) => k <= rule.until);

  // count 语义：从 dtstart 起算的前 N 次。
  // 顺序至关重要 —— RFC 5545 要求 COUNT 先约束 RRULE 生成的集合，EXDATE 再剔除。
  // 因此这里**必须先切片、后按 exdate 过滤**；反过来的话被跳过的日子就不占名额了。
  if (rule.count) {
    const all = [...new Set(enumerateDateKeys(rule, rule.dtstart, toKey))].sort();
    const allowed = new Set(all.slice(0, rule.count));
    keys = keys.filter((k) => allowed.has(k));
  }

  for (const key of keys) {
    if (out.length >= limit) break;
    const startAt = localAt(key, startMin);
    const endAt = localAt(key, startMin + duration);
    const iso = toLocalDateTime(startAt);
    const done = completions.get(`${task.id}|${key}`);
    out.push({
      taskId: task.id,
      kind: 'fixed',
      key,
      dateKey: key,
      allDay: false,
      startMinutes: startMin,
      endMinutes: startMin + duration,
      durationMinutes: duration,
      startAt,
      endAt,
      spansMidnight,
      overdue: false,
      done: !!done,
      completion: done || null,
      endsOnNextDay: spansMidnight ? toDateKey(endAt) : null,
      _isoStart: iso,
    });
  }

  return out;
}

/** 构造完成打卡记录的主键 —— 固定任务按"归属日"，截止任务按"精确到分钟"。 */
export function occurrenceCompletionId(taskId, occKey) {
  return `${taskId}|${occKey}`;
}

/**
 * 生成规则的中文描述，供列表与编辑器回显。
 * 例："每周一、三 09:00–10:00"、"每月 15 日 14:00–15:30"、"每 2 周的周五"
 */
export function describeRecurrence(input, opts = {}) {
  const { rule } = normalizeRecurrence(input);
  const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const timePart = opts.omitTime ? '' : ` ${rule.startTime}–${rule.endTime}`;
  const ivPart = rule.interval > 1 ? `每 ${rule.interval} ` : '每';

  let body = '';
  switch (rule.freq) {
    case 'daily':
      body = rule.interval > 1 ? `每 ${rule.interval} 天` : '每天';
      break;
    case 'weekly':
      if (rule.byWeekday.length === 7) {
        body = rule.interval > 1 ? `每 ${rule.interval} 周（每天）` : '每天';
      } else {
        body = `${ivPart}周 ${rule.byWeekday.map((d) => WD[d]).join('、')}`;
      }
      break;
    case 'monthly':
      if (rule.nthWeekday) {
        const { ordinal, weekday } = rule.nthWeekday;
        const ordText = ordinal === -1 ? '最后一个' : `第${['', '一', '二', '三', '四'][ordinal]}个`;
        body = `${ivPart}月${ordText}${WD[weekday]}`;
      } else {
        body = `${ivPart}月 ${rule.byMonthday.map((d) => `${d} 日`).join('、')}`;
      }
      break;
    case 'yearly':
      body = `${ivPart}年 ${rule.byMonth.map((m) => `${m} 月`).join('、')} ${rule.byMonthday
        .map((d) => `${d} 日`)
        .join('、')}`;
      break;
  }

  const parts = [`${body}${timePart}`];
  if (rule.until) parts.push(`至 ${rule.until}`);
  else if (rule.count) parts.push(`共 ${rule.count} 次`);
  if (rule.exdates.length) parts.push(`跳过 ${rule.exdates.length} 天`);
  return parts.join('，');
}

/** 校验任务的完整性，返回问题列表（空数组表示通过）。供前后端共用。 */
export function validateTask(task) {
  const errs = [];
  if (!task || typeof task !== 'object') return ['任务不能为空'];
  if (!task.id || typeof task.id !== 'string') errs.push('缺少任务 id');
  const title = (task.title || '').trim();
  if (!title) errs.push('标题不能为空');
  if (title.length > 200) errs.push('标题过长（上限 200 字）');

  if (!['fixed', 'deadline'].includes(task.kind)) {
    errs.push(`未知的任务类型「${task.kind}」`);
    return errs;
  }

  if (task.kind === 'fixed') {
    const { rule, issues } = normalizeRecurrence(task.recurrence);
    errs.push(...issues);
    if (rule.freq === 'monthly' && !rule.nthWeekday && rule.byMonthday.length === 0) {
      errs.push('每月重复需要指定日期');
    }
  } else {
    if (!parseLocalDateTime(task.dueAt)) errs.push('截止时间格式应为 YYYY-MM-DDTHH:mm');
  }

  if (task.notes && String(task.notes).length > 5000) errs.push('备注过长（上限 5000 字）');
  if (task.tags && (!Array.isArray(task.tags) || task.tags.length > 20)) {
    errs.push('标签数量过多（上限 20 个）');
  }
  return errs;
}
