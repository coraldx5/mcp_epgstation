import { readFileSync } from "node:fs";
import { z } from "zod";

const BASE_URL = (process.env.EPGSTATION_URL ?? "http://192.168.0.31:8888/api").replace(/\/$/, "");
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const jstDateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

async function epgFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const method = options.method ?? "GET";
  console.log(`[EPGStation] --> ${method} ${url}`);
  if (options.body) {
    console.log(`[EPGStation]     body: ${options.body}`);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options,
    });
  } catch (err) {
    console.error(`[EPGStation] fetch failed: ${err.message}`);
    throw err;
  }

  console.log(`[EPGStation] <-- ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[EPGStation]     error body: ${text}`);
    throw new Error(`EPGStation ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function epgFetchImage(path) {
  const url = `${BASE_URL}${path}`;
  console.log(`[EPGStation] --> GET ${url}`);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`[EPGStation] fetch failed: ${err.message}`);
    throw err;
  }

  console.log(`[EPGStation] <-- ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[EPGStation]     error body: ${text}`);
    throw new Error(`EPGStation ${res.status}: ${text}`);
  }

  const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0].trim();
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return { content: [{ type: "text", text: `![logo](data:${mimeType};base64,${base64})` }] };
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function getReserveStatus(reserve) {
  if (reserve.isSkip) return "除外";
  if (reserve.isConflict) return "競合";
  if (reserve.isOverlap) return "重複";
  return "通常";
}

function parseDateText(dateText) {
  const match = JST_DATE_PATTERN.exec(dateText);
  if (!match) {
    throw new Error(`Invalid date format: ${dateText}. Expected YYYY-MM-DD.`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getJstDateTimeParts(value) {
  return Object.fromEntries(
    jstDateTimeFormatter
      .formatToParts(new Date(value ?? 0))
      .filter((part) => ["month", "day", "hour", "minute"].includes(part.type))
      .map((part) => [part.type, part.value])
  );
}

function formatReserveTime(startAt, endAt) {
  const start = getJstDateTimeParts(startAt ?? 0);
  const end = getJstDateTimeParts(endAt ?? 0);
  return `${start.month}/${start.day} ${start.hour}:${start.minute}〜${end.hour}:${end.minute}`;
}

function getStartOfDayMs(dateText) {
  const { year, month, day } = parseDateText(dateText);
  return Date.UTC(year, month - 1, day) - JST_OFFSET_MS;
}

function getEndOfDayMs(dateText) {
  const { year, month, day } = parseDateText(dateText);
  return Date.UTC(year, month - 1, day + 1) - JST_OFFSET_MS - 1;
}

function getCurrentJstDayStartMs(nowMs = Date.now()) {
  return Math.floor((nowMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

function isPastOnlyDateRange(endDate) {
  if (!endDate) return false;

  return getEndOfDayMs(endDate) < getCurrentJstDayStartMs();
}

function buildViewItems(programs, channelMap, logoMap, getStatus) {
  return programs.map((program) => ({
    name: program.name ?? "",
    channelId: program.channelId,
    channelName: channelMap[program.channelId] ?? "",
    logo: logoMap[program.channelId] ?? "",
    startAt: program.startAt ?? 0,
    endAt: program.endAt ?? 0,
    timeText: formatReserveTime(program.startAt, program.endAt),
    status: getStatus(program),
    isSkip: !!program.isSkip,
    isConflict: !!program.isConflict,
    isOverlap: !!program.isOverlap,
  }));
}

function filterProgramsByDateRange(programs, startDate, endDate) {
  let filteredPrograms = programs;

  if (startDate) {
    const from = getStartOfDayMs(startDate);
    filteredPrograms = filteredPrograms.filter((program) => (program.endAt ?? 0) >= from);
  }

  if (endDate) {
    const to = getEndOfDayMs(endDate);
    filteredPrograms = filteredPrograms.filter((program) => (program.startAt ?? 0) <= to);
  }

  return filteredPrograms;
}

async function fetchPagedItems(path, arrayKey, params, pageSize = 200) {
  const items = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const searchParams = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      limit: String(pageSize),
      offset: String(offset),
    });
    const data = await epgFetch(`${path}?${searchParams}`);
    const pageItems = Array.isArray(data[arrayKey]) ? data[arrayKey] : [];
    items.push(...pageItems);

    total = typeof data.total === "number" ? data.total : offset + pageItems.length;
    if (pageItems.length < pageSize) break;

    offset += pageItems.length;
  }

  return items;
}

async function getChannelMap() {
  const channels = await epgFetch("/channels").catch(() => []);
  const channelMap = {};
  for (const channel of (Array.isArray(channels) ? channels : [])) {
    channelMap[channel.id] = channel.halfWidthName ?? channel.name ?? "";
  }
  return channelMap;
}

async function getLogoMap(channelIds) {
  const logoMap = {};
  await Promise.allSettled(
    channelIds.map(async (channelId) => {
      try {
        const res = await fetch(`${BASE_URL}/channels/${channelId}/logo`);
        if (!res.ok) return;
        const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0].trim();
        const buf = await res.arrayBuffer();
        logoMap[channelId] = `data:${mimeType};base64,${Buffer.from(buf).toString("base64")}`;
      } catch {
        // Ignore missing logos.
      }
    })
  );
  return logoMap;
}

async function getReservesViewData(type = "all", limit = 200, startDate, endDate, { includeLogos = true } = {}) {
  let reserves;
  if (startDate || endDate) {
    reserves = await fetchPagedItems("/reserves", "reserves", { type, isHalfWidth: "true" });
    reserves = filterProgramsByDateRange(reserves, startDate, endDate).slice(0, limit);
  } else {
    const p = new URLSearchParams({ type, limit, offset: 0, isHalfWidth: "true" });
    const data = await epgFetch(`/reserves?${p}`);
    reserves = data.reserves ?? [];
  }

  const channelMap = await getChannelMap();
  const logoMap = includeLogos
    ? await getLogoMap([...new Set(reserves.map((reserve) => reserve.channelId).filter(Boolean))])
    : {};

  const items = buildViewItems(reserves, channelMap, logoMap, getReserveStatus);

  return {
    items,
    count: items.length,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    title: "録画予約一覧",
    emptyMessage: "該当する予約はありません。",
    source: "reserves",
  };
}

async function getRecordedViewData(limit = 200, startDate, endDate, { includeLogos = true } = {}) {
  let records;
  if (startDate || endDate) {
    records = await fetchPagedItems("/recorded", "records", { isHalfWidth: "true" });
    records = filterProgramsByDateRange(records, startDate, endDate).slice(0, limit);
  } else {
    const p = new URLSearchParams({ limit, offset: 0, isHalfWidth: "true" });
    const data = await epgFetch(`/recorded?${p}`);
    records = data.records ?? [];
  }

  const channelMap = await getChannelMap();
  const logoMap = includeLogos
    ? await getLogoMap([...new Set(records.map((record) => record.channelId).filter(Boolean))])
    : {};
  const items = buildViewItems(records, channelMap, logoMap, () => "録画済み");

  return {
    items,
    count: items.length,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    title: "録画済み一覧",
    emptyMessage: "該当する録画はありません。",
    source: "recorded",
  };
}

async function getReservesOrRecordedViewData(type = "all", limit = 200, startDate, endDate, { includeLogos = true } = {}) {
  if (isPastOnlyDateRange(endDate)) {
    return getRecordedViewData(limit, startDate, endDate, { includeLogos });
  }

  return getReservesViewData(type, limit, startDate, endDate, { includeLogos });
}

export function buildReservesTextFromItems(items, startDate, endDate, title = "録画予約一覧", emptyMessage = "該当する予約はありません。") {
  const period = [startDate, endDate].filter(Boolean).join(" 〜 ");
  if (items.length === 0) {
    return `📺 ${title}${period ? `  期間: ${period}` : ""}\n\n${emptyMessage}`;
  }

  const header = `📺 ${title}（${items.length} 件）${period ? `  期間: ${period}` : ""}\n\n| 時間 | 放送局 | 番組名 | 状態 |\n|------|--------|--------|------|`;
  const lines = items.map((item) => `| ${item.timeText} | ${item.channelName} | ${item.name} | ${item.status} |`);
  return `${header}\n${lines.join("\n")}`;
}

export async function buildReservesText(type = "all", limit = 200, startDate, endDate) {
  const data = await getReservesOrRecordedViewData(type, limit, startDate, endDate, { includeLogos: false });
  return buildReservesTextFromItems(data.items, data.startDate, data.endDate, data.title, data.emptyMessage);
}

export async function getReservesWidgetData(type = "all", limit = 200, startDate, endDate) {
  return getReservesOrRecordedViewData(type, limit, startDate, endDate, { includeLogos: true });
}

export function buildReservesWidgetHtml() {
  return readFileSync(new URL("./public/reserves-widget.html", import.meta.url), "utf8");
}

export function registerEpgStationTools(server) {

  server.tool("epg_get_channels", "EPGStation に登録されている放送局一覧を返します。各放送局の id が他ツールで必要です。", {}, async () => ok(await epgFetch("/channels")));

  server.tool("epg_get_channel_logo", "指定した放送局のロゴ画像を取得します。", {
    channelId: z.number().int().describe("放送局 ID (epg_get_channels で確認)"),
  }, async ({ channelId }) => {
    return epgFetchImage(`/channels/${channelId}/logo`);
  });

  server.tool("epg_get_schedule", "指定した放送局の番組表を取得します。channelId は epg_get_channels で確認してください。", {
    channelId: z.number().int().describe("放送局 ID"),
    startAt: z.number().int().optional().describe("開始時刻 (UNIX ms)。省略時は現在時刻"),
    days: z.number().int().min(1).max(7).default(1).describe("取得日数 (1〜7)"),
  }, async ({ channelId, startAt, days }) => {
    const p = new URLSearchParams({ startAt: startAt ?? Date.now(), days, isHalfWidth: "true" });
    return ok(await epgFetch(`/schedules/${channelId}?${p}`));
  });

  server.tool("epg_search_programs", "キーワードで放送予定の番組を検索します。予約候補の番組 ID を調べるのに便利です。", {
    keyword: z.string().describe("検索キーワード"),
    limit: z.number().int().min(1).max(100).default(20).describe("最大取得件数"),
    GR: z.boolean().default(true).describe("地上波を含むか"),
    BS: z.boolean().default(true).describe("BS を含むか"),
    CS: z.boolean().default(false).describe("CS を含むか"),
  }, async ({ keyword, limit, GR, BS, CS }) => {
    const body = { option: { keyword, name: true, description: true, GR, BS, CS }, isHalfWidth: true, limit };
    return ok(await epgFetch("/schedules/search", { method: "POST", body: JSON.stringify(body) }));
  });

  server.tool("epg_get_program", "番組 ID を指定して番組の詳細情報を取得します。", {
    programId: z.number().int().describe("番組 ID"),
  }, async ({ programId }) => {
    return ok(await epgFetch(`/schedules/detail/${programId}?isHalfWidth=true`));
  });

  server.tool("epg_get_reserves", "予約中の番組一覧を取得します。", {
    type: z.enum(["all", "normal", "conflict", "skip", "overlap"]).default("all").describe("取得する予約の種類"),
    limit: z.number().int().min(1).max(200).default(30).describe("最大取得件数"),
    offset: z.number().int().min(0).default(0).describe("オフセット"),
  }, async ({ type, limit, offset }) => {
    const p = new URLSearchParams({ type, limit, offset, isHalfWidth: "true" });
    return ok(await epgFetch(`/reserves?${p}`));
  });

  server.tool("epg_get_reserve_counts", "通常・競合・除外・重複の予約件数をまとめて返します。", {}, async () => ok(await epgFetch("/reserves/cnts")));

  server.tool("epg_add_reserve", "番組 ID を指定して予約を追加します。事前に epg_search_programs か epg_get_schedule で番組 ID を確認してください。", {
    programId: z.number().int().describe("予約する番組の ID"),
    allowEndLack: z.boolean().default(true).describe("末尾切れを許可するか"),
  }, async ({ programId, allowEndLack }) => {
    return ok(await epgFetch("/reserves", { method: "POST", body: JSON.stringify({ programId, allowEndLack }) }));
  });

  server.tool("epg_delete_reserve", "予約 ID を指定して予約を削除します。", {
    reserveId: z.number().int().describe("削除する予約の ID"),
  }, async ({ reserveId }) => {
    await epgFetch(`/reserves/${reserveId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `予約 ID ${reserveId} を削除しました。` }] };
  });

  server.tool("epg_get_rules", "自動録画ルールの一覧を取得します。", {
    keyword: z.string().optional().describe("キーワードで絞り込み"),
    limit: z.number().int().min(1).max(200).default(30).describe("最大取得件数"),
    offset: z.number().int().min(0).default(0).describe("オフセット"),
  }, async ({ keyword, limit, offset }) => {
    const p = new URLSearchParams({ limit, offset });
    if (keyword) p.set("keyword", keyword);
    return ok(await epgFetch(`/rules?${p}`));
  });

  server.tool("epg_enable_rule", "指定したルール ID の録画ルールを有効にします。", {
    ruleId: z.number().int().describe("ルール ID"),
  }, async ({ ruleId }) => {
    await epgFetch(`/rules/${ruleId}/enable`, { method: "PUT" });
    return { content: [{ type: "text", text: `ルール ID ${ruleId} を有効にしました。` }] };
  });

  server.tool("epg_disable_rule", "指定したルール ID の録画ルールを無効にします。", {
    ruleId: z.number().int().describe("ルール ID"),
  }, async ({ ruleId }) => {
    await epgFetch(`/rules/${ruleId}/disable`, { method: "PUT" });
    return { content: [{ type: "text", text: `ルール ID ${ruleId} を無効にしました。` }] };
  });

  server.tool("epg_get_recorded", "録画済み番組の一覧を取得します。番組名やチャンネルで絞り込めます。新しい順で返します。", {
    keyword: z.string().optional().describe("番組名キーワードで絞り込み"),
    channelId: z.number().int().optional().describe("放送局 ID で絞り込み"),
    limit: z.number().int().min(1).max(200).default(30).describe("最大取得件数"),
    offset: z.number().int().min(0).default(0).describe("オフセット"),
  }, async ({ keyword, channelId, limit, offset }) => {
    const p = new URLSearchParams({ limit, offset, isHalfWidth: "true" });
    if (keyword) p.set("keyword", keyword);
    if (channelId != null) p.set("channelId", String(channelId));
    return ok(await epgFetch(`/recorded?${p}`));
  });

  server.tool("epg_get_recorded_detail", "録画 ID を指定して録画番組の詳細情報を取得します。", {
    recordedId: z.number().int().describe("録画 ID"),
  }, async ({ recordedId }) => {
    return ok(await epgFetch(`/recorded/${recordedId}?isHalfWidth=true`));
  });

  server.tool("epg_delete_recorded", "録画 ID を指定して録画番組を削除します。元に戻せません。", {
    recordedId: z.number().int().describe("削除する録画の ID"),
  }, async ({ recordedId }) => {
    await epgFetch(`/recorded/${recordedId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `録画 ID ${recordedId} を削除しました。` }] };
  });

  server.tool("epg_get_encode_info", "現在実行中・待機中のエンコードジョブ一覧を取得します。", {}, async () => ok(await epgFetch("/encode?isHalfWidth=true")));

  server.tool("epg_get_storage", "録画ディスクの空き容量・使用量・総容量を取得します。", {}, async () => ok(await epgFetch("/storages")));

  server.tool("epg_get_version", "EPGStation のバージョン情報を返します。", {}, async () => ok(await epgFetch("/version")));
}
