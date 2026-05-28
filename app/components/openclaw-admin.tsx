"use client";

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import ResetIcon from "../icons/reload.svg";
import CloseIcon from "../icons/close.svg";
import { IconButton } from "./button";
import { ErrorBoundary } from "./error";
import { Path } from "../constant";
import {
  getOpenClawAdminSessions,
  type OpenClawAdminSessionsResponse,
  type OpenClawPresenceDevice,
} from "../client/platforms/openclaw";
import styles from "./openclaw-admin.module.scss";

function formatDate(value?: string) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString();
}

function parseFromUserAgent(userAgent: string) {
  const source = userAgent || "Unknown device";
  const os = /Mac OS X|Macintosh/i.test(source)
    ? "macOS"
    : /Windows/i.test(source)
    ? "Windows"
    : /Android/i.test(source)
    ? "Android"
    : /iPhone|iPad/i.test(source)
    ? "iOS"
    : /Linux/i.test(source)
    ? "Linux"
    : "未知系统";
  const browser = /Edg\//i.test(source)
    ? "Edge"
    : /Chrome\//i.test(source)
    ? "Chrome"
    : /Safari\//i.test(source)
    ? "Safari"
    : /Firefox\//i.test(source)
    ? "Firefox"
    : "未知浏览器";
  const device = /iPhone/i.test(source)
    ? "iPhone"
    : /iPad/i.test(source)
    ? "iPad"
    : /Macintosh|Mac OS X/i.test(source)
    ? "Mac"
    : /Windows/i.test(source)
    ? "Windows PC"
    : /Android/i.test(source)
    ? "Android 设备"
    : "未知设备";
  return { device, os, browser };
}

function summarizeDevice(device: OpenClawPresenceDevice) {
  const parsed = parseFromUserAgent(device.userAgent);
  const model = device.deviceModel || parsed.device;
  const os = device.platform || parsed.os;
  const browser = device.browser || parsed.browser;
  return `${model}（${os} ${browser}）`;
}

function DeviceRow(props: { device: OpenClawPresenceDevice }) {
  const { device } = props;
  return (
    <div className={styles["device-row"]}>
      <div className={styles["device-primary"]}>
        <span
          className={`${styles["status-dot"]} ${
            styles[`status-${device.status}`]
          }`}
        />
        <div>
          <div className={styles["device-name"]}>{summarizeDevice(device)}</div>
          <div className={styles["device-agent"]}>{device.userAgent}</div>
        </div>
      </div>
      <div className={styles["device-cell"]}>
        <span>{device.ip || "-"}</span>
        <small>{device.location || "未知位置"}</small>
      </div>
      <div className={styles["device-cell"]}>
        <span>{formatDate(device.lastSeenAt)}</span>
        <small>首次登录 {formatDate(device.createdAt)}</small>
      </div>
      <div className={styles["device-status"]}>
        {device.status === "online" ? "在线" : "离线"}
      </div>
    </div>
  );
}

export function OpenClawAdminPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OpenClawAdminSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedAccount, setSelectedAccount] = useState("all");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getOpenClawAdminSessions());
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 30 * 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    const accounts = data?.accounts ?? [];
    return {
      accounts: accounts.length,
      online: accounts.reduce((sum, account) => sum + account.onlineCount, 0),
      devices: accounts.reduce((sum, account) => sum + account.totalCount, 0),
    };
  }, [data]);
  const visibleDevices = useMemo(() => {
    const accounts = data?.accounts ?? [];
    const selectedAccounts =
      selectedAccount === "all"
        ? accounts
        : accounts.filter((account) => account.username === selectedAccount);
    return selectedAccounts.flatMap((account) =>
      account.devices.map((device) => ({
        ...device,
        username: account.username,
      })),
    );
  }, [data, selectedAccount]);

  return (
    <ErrorBoundary>
      <div className="window-header" data-tauri-drag-region>
        <div className="window-header-title">
          <div className="window-header-main-title">OpenClaw 登录监控</div>
          <div className="window-header-sub-title">
            更新于 {formatDate(data?.generatedAt)}
          </div>
        </div>
        <div className="window-actions">
          <div className="window-action-button">
            <IconButton
              icon={<ResetIcon />}
              onClick={load}
              disabled={loading}
              bordered
            />
          </div>
          <div className="window-action-button">
            <IconButton
              icon={<CloseIcon />}
              onClick={() => navigate(Path.Settings)}
              bordered
            />
          </div>
        </div>
      </div>

      <div className={styles["openclaw-admin"]}>
        <div className={styles["summary-strip"]}>
          <div>
            <span>{totals.online}</span>
            <small>在线设备</small>
          </div>
          <div>
            <span>{totals.accounts}</span>
            <small>账号数</small>
          </div>
          <div>
            <span>{totals.devices}</span>
            <small>已记录设备</small>
          </div>
        </div>

        {error && <div className={styles["state-panel"]}>{error}</div>}
        {!error && loading && !data && (
          <div className={styles["state-panel"]}>正在加载登录记录...</div>
        )}
        {!error && data && data.accounts.length === 0 && (
          <div className={styles["state-panel"]}>
            还没有 OpenClaw 登录记录。
          </div>
        )}

        {data && data.accounts.length > 0 && (
          <section className={styles["session-panel"]}>
            <div className={styles["session-toolbar"]}>
              <div>
                <h2>设备列表</h2>
                <p>
                  {selectedAccount === "all" ? "全部账号" : selectedAccount}，
                  共 {visibleDevices.length} 台设备
                </p>
              </div>
              <select
                aria-label="选择账号"
                value={selectedAccount}
                onChange={(event) =>
                  setSelectedAccount(event.currentTarget.value)
                }
              >
                <option value="all">全部账号</option>
                {data.accounts.map((account) => (
                  <option value={account.username} key={account.username}>
                    {account.username}（{account.onlineCount}/
                    {account.totalCount}）
                  </option>
                ))}
              </select>
            </div>
            <div className={styles["device-table"]}>
              <div className={styles["device-heading"]}>
                <span>设备</span>
                <span>IP / 位置</span>
                <span>活跃时间</span>
                <span>状态</span>
              </div>
              {visibleDevices.map((device) => (
                <DeviceRow device={device} key={device.deviceId} />
              ))}
            </div>
          </section>
        )}
      </div>
    </ErrorBoundary>
  );
}
