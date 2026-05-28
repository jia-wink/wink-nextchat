import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getServerSideConfig } from "@/app/config/server";
import { getRequestIp, type OpenClawAuthSession } from "./shared";

export const OPENCLAW_ADMIN_USERNAME = "admin";
export const OPENCLAW_ONLINE_WINDOW_MS = 5 * 60 * 1000;

const LOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCATION_TIMEOUT_MS = 10 * 1000;
const UNKNOWN_LOCATION = "未知位置";
const LOCAL_LOCATION = "本地网络";

export type OpenClawDeviceMetadata = {
  model?: string;
  platform?: string;
  platformVersion?: string;
  browser?: string;
  browserVersion?: string;
  userAgent?: string;
};

export type OpenClawPresenceDevice = {
  deviceId: string;
  username: string;
  agents: string[];
  ip: string;
  location: string;
  userAgent: string;
  deviceModel?: string;
  platform?: string;
  platformVersion?: string;
  browser?: string;
  browserVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  loggedOutAt?: string;
};

type LocationCacheEntry = {
  location: string;
  resolvedAt: string;
};

type PresenceFile = {
  devices: OpenClawPresenceDevice[];
  locations: Record<string, LocationCacheEntry>;
};

type AdminDevice = OpenClawPresenceDevice & {
  status: "online" | "offline";
};

export type OpenClawAdminSessionGroup = {
  username: string;
  onlineCount: number;
  totalCount: number;
  devices: AdminDevice[];
};

export type OpenClawAdminSessionsResponse = {
  generatedAt: string;
  onlineWindowMs: number;
  accounts: OpenClawAdminSessionGroup[];
};

let writeQueue = Promise.resolve();

function getPresencePath(): string {
  const config = getServerSideConfig() as ReturnType<
    typeof getServerSideConfig
  > & {
    nextchatOpenClawPresenceStore?: string;
  };
  const explicit = config.nextchatOpenClawPresenceStore?.trim();
  if (explicit) {
    return explicit;
  }

  const uploadDir = config.nextchatUploadDir?.trim();
  if (uploadDir) {
    return path.join(path.dirname(uploadDir), "openclaw-presence.json");
  }

  return path.join(os.homedir(), ".nextchat", "openclaw-presence.json");
}

async function readPresenceFile(): Promise<PresenceFile> {
  try {
    const raw = await fs.readFile(getPresencePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<PresenceFile>;
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      locations:
        parsed.locations && typeof parsed.locations === "object"
          ? parsed.locations
          : {},
    };
  } catch {
    return { devices: [], locations: {} };
  }
}

async function writePresenceFile(data: PresenceFile) {
  const filePath = getPresencePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function mutatePresenceFile(
  updater: (data: PresenceFile) => Promise<PresenceFile> | PresenceFile,
) {
  writeQueue = writeQueue.then(async () => {
    const current = await readPresenceFile();
    const next = await updater(current);
    await writePresenceFile(next);
  });
  return writeQueue;
}

function isLocalIp(ip: string): boolean {
  if (!ip || ip === "::1" || ip === "127.0.0.1" || ip === "localhost") {
    return true;
  }
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) {
    return true;
  }
  const parts = ip.split(".").map((part) => Number(part));
  return (
    parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
  );
}

function countryName(region?: string): string | undefined {
  const value = region?.trim();
  if (!value) {
    return undefined;
  }
  const translated = translateLocationPart(value);
  if (translated !== value) {
    return translated;
  }
  if (value.length !== 2) {
    return value;
  }
  try {
    return (
      new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(value) || value
    );
  } catch {
    return value;
  }
}

function translateLocationPart(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  const map: Record<string, string> = {
    China: "中国",
    "Hong Kong": "中国香港",
    Hongkong: "中国香港",
    Macao: "中国澳门",
    Macau: "中国澳门",
    Taiwan: "中国台湾",
    Guangdong: "广东",
    Guangzhou: "广州",
    Shenzhen: "深圳",
    Dongguan: "东莞",
    Foshan: "佛山",
    Zhuhai: "珠海",
    Beijing: "北京",
    Shanghai: "上海",
    Tianjin: "天津",
    Chongqing: "重庆",
    Zhejiang: "浙江",
    Hangzhou: "杭州",
    Jiangsu: "江苏",
    Nanjing: "南京",
    Suzhou: "苏州",
    Sichuan: "四川",
    Chengdu: "成都",
    Hubei: "湖北",
    Wuhan: "武汉",
    Hunan: "湖南",
    Changsha: "长沙",
    Fujian: "福建",
    Fuzhou: "福州",
    Xiamen: "厦门",
    Shandong: "山东",
    Qingdao: "青岛",
    Jinan: "济南",
    Henan: "河南",
    Zhengzhou: "郑州",
    Shaanxi: "陕西",
    Xian: "西安",
    "Xi'an": "西安",
    Guangxi: "广西",
    Nanning: "南宁",
    Yunnan: "云南",
    Kunming: "昆明",
    Guizhou: "贵州",
    Guiyang: "贵阳",
    Hainan: "海南",
    Haikou: "海口",
    Sanya: "三亚",
    Hebei: "河北",
    Shanxi: "山西",
    Liaoning: "辽宁",
    Jilin: "吉林",
    Heilongjiang: "黑龙江",
    Anhui: "安徽",
    Jiangxi: "江西",
    Inner: "内蒙古",
    Singapore: "新加坡",
    Kowloon: "九龙",
  };
  return map[text] || text;
}

function joinLocation(parts: Array<string | undefined>): string {
  return parts
    .map((part) => translateLocationPart(part))
    .filter(Boolean)
    .join(", ");
}

function localizeStoredLocation(location: string): string {
  if (!location || location === "Unknown location") {
    return UNKNOWN_LOCATION;
  }
  if (location === "Local network") {
    return LOCAL_LOCATION;
  }
  return joinLocation(location.split(","));
}

async function fetchJsonWithTimeout(url: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOCATION_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`location lookup failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function locateIp(ip: string): Promise<string> {
  if (isLocalIp(ip)) {
    return LOCAL_LOCATION;
  }

  try {
    const payload = await fetchJsonWithTimeout(
      `https://ip-api.globecul.com/json/${encodeURIComponent(ip)}?lang=zh-CN`,
    );
    const location = joinLocation([
      payload?.city,
      payload?.regionName,
      countryName(payload?.countryCode || payload?.country),
    ]);
    if (location) {
      return location;
    }
  } catch (error) {
    console.warn("[OpenClaw Presence] primary location lookup failed", error);
  }

  try {
    const payload = await fetchJsonWithTimeout(
      `https://ip.011102.xyz?ip=${encodeURIComponent(ip)}`,
    );
    const info = payload?.IP || payload || {};
    const location = joinLocation([
      info.City,
      info.Region,
      countryName(info.Country),
    ]);
    if (location) {
      return location;
    }
  } catch (error) {
    console.warn("[OpenClaw Presence] fallback location lookup failed", error);
  }

  return UNKNOWN_LOCATION;
}

async function resolveLocation(
  data: PresenceFile,
  ip: string,
): Promise<string> {
  if (!ip) {
    return UNKNOWN_LOCATION;
  }
  const cached = data.locations[ip];
  if (
    cached &&
    Date.now() - new Date(cached.resolvedAt).getTime() < LOCATION_CACHE_TTL_MS
  ) {
    return localizeStoredLocation(cached.location);
  }

  const location = await locateIp(ip);
  data.locations[ip] = {
    location,
    resolvedAt: new Date().toISOString(),
  };
  return location;
}

export function createOpenClawDeviceId(): string {
  return randomUUID();
}

export async function touchOpenClawPresence(params: {
  req: NextRequest;
  session: OpenClawAuthSession;
  deviceId: string;
  device?: OpenClawDeviceMetadata;
}) {
  await mutatePresenceFile(async (data) => {
    const now = new Date().toISOString();
    const ip = getRequestIp(params.req);
    const location = await resolveLocation(data, ip);
    const userAgent =
      params.device?.userAgent?.trim() ||
      params.req.headers.get("user-agent")?.trim() ||
      "Unknown device";
    const deviceModel =
      params.device?.model?.trim() ||
      params.req.headers.get("sec-ch-ua-model")?.replaceAll('"', "").trim() ||
      undefined;
    const platform =
      params.device?.platform?.trim() ||
      params.req.headers
        .get("sec-ch-ua-platform")
        ?.replaceAll('"', "")
        .trim() ||
      undefined;
    const existing = data.devices.find(
      (device) => device.deviceId === params.deviceId,
    );

    if (existing) {
      existing.username = params.session.username;
      existing.agents = params.session.agents;
      existing.ip = ip || existing.ip || "";
      existing.location = location;
      existing.userAgent = userAgent;
      existing.deviceModel = deviceModel;
      existing.platform = platform;
      existing.platformVersion = params.device?.platformVersion?.trim();
      existing.browser = params.device?.browser?.trim();
      existing.browserVersion = params.device?.browserVersion?.trim();
      existing.lastSeenAt = now;
      delete existing.loggedOutAt;
    } else {
      data.devices.push({
        deviceId: params.deviceId,
        username: params.session.username,
        agents: params.session.agents,
        ip,
        location,
        userAgent,
        deviceModel,
        platform,
        platformVersion: params.device?.platformVersion?.trim(),
        browser: params.device?.browser?.trim(),
        browserVersion: params.device?.browserVersion?.trim(),
        createdAt: now,
        lastSeenAt: now,
      });
    }

    return data;
  });
}

export async function logoutOpenClawPresence(deviceId?: string) {
  if (!deviceId) {
    return;
  }

  await mutatePresenceFile((data) => {
    const now = new Date().toISOString();
    const existing = data.devices.find(
      (device) => device.deviceId === deviceId,
    );
    if (existing) {
      existing.loggedOutAt = now;
      existing.lastSeenAt = now;
    }
    return data;
  });
}

export async function getOpenClawAdminSessions(): Promise<OpenClawAdminSessionsResponse> {
  const data = await readPresenceFile();
  const now = Date.now();
  const grouped = new Map<string, AdminDevice[]>();

  for (const device of data.devices) {
    const lastSeen = new Date(device.lastSeenAt).getTime();
    const online =
      !device.loggedOutAt &&
      Number.isFinite(lastSeen) &&
      now - lastSeen <= OPENCLAW_ONLINE_WINDOW_MS;
    const nextDevice: AdminDevice = {
      ...device,
      location: localizeStoredLocation(device.location),
      status: online ? "online" : "offline",
    };
    const list = grouped.get(device.username) ?? [];
    list.push(nextDevice);
    grouped.set(device.username, list);
  }

  const accounts = [...grouped.entries()]
    .map(([username, devices]) => {
      const sortedDevices = devices.sort(
        (a, b) =>
          new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
      );
      return {
        username,
        onlineCount: sortedDevices.filter(
          (device) => device.status === "online",
        ).length,
        totalCount: sortedDevices.length,
        devices: sortedDevices,
      };
    })
    .sort(
      (a, b) =>
        b.onlineCount - a.onlineCount || a.username.localeCompare(b.username),
    );

  return {
    generatedAt: new Date().toISOString(),
    onlineWindowMs: OPENCLAW_ONLINE_WINDOW_MS,
    accounts,
  };
}
