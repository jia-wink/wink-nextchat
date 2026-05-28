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

function summarizeDevice(userAgent: string) {
  const source = userAgent || "Unknown device";
  const os = /Mac OS X|Macintosh/i.test(source)
    ? "Mac"
    : /Windows/i.test(source)
    ? "Windows"
    : /Android/i.test(source)
    ? "Android"
    : /iPhone|iPad/i.test(source)
    ? "iOS"
    : /Linux/i.test(source)
    ? "Linux"
    : "Device";
  const browser = /Edg\//i.test(source)
    ? "Edge"
    : /Chrome\//i.test(source)
    ? "Chrome"
    : /Safari\//i.test(source)
    ? "Safari"
    : /Firefox\//i.test(source)
    ? "Firefox"
    : "Browser";
  return `${os} ${browser}`;
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
          <div className={styles["device-name"]}>
            {summarizeDevice(device.userAgent)}
          </div>
          <div className={styles["device-agent"]}>{device.userAgent}</div>
        </div>
      </div>
      <div className={styles["device-cell"]}>
        <span>{device.ip || "-"}</span>
        <small>{device.location || "Unknown location"}</small>
      </div>
      <div className={styles["device-cell"]}>
        <span>{formatDate(device.lastSeenAt)}</span>
        <small>First seen {formatDate(device.createdAt)}</small>
      </div>
      <div className={styles["device-status"]}>{device.status}</div>
    </div>
  );
}

export function OpenClawAdminPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OpenClawAdminSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  return (
    <ErrorBoundary>
      <div className="window-header" data-tauri-drag-region>
        <div className="window-header-title">
          <div className="window-header-main-title">OpenClaw Monitor</div>
          <div className="window-header-sub-title">
            Updated {formatDate(data?.generatedAt)}
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
            <small>Online devices</small>
          </div>
          <div>
            <span>{totals.accounts}</span>
            <small>Accounts</small>
          </div>
          <div>
            <span>{totals.devices}</span>
            <small>Known devices</small>
          </div>
        </div>

        {error && <div className={styles["state-panel"]}>{error}</div>}
        {!error && loading && !data && (
          <div className={styles["state-panel"]}>Loading sessions...</div>
        )}
        {!error && data && data.accounts.length === 0 && (
          <div className={styles["state-panel"]}>No OpenClaw logins yet.</div>
        )}

        <div className={styles["account-list"]}>
          {data?.accounts.map((account) => (
            <section
              className={styles["account-section"]}
              key={account.username}
            >
              <div className={styles["account-header"]}>
                <div>
                  <h2>{account.username}</h2>
                  <p>
                    {account.onlineCount} online / {account.totalCount} devices
                  </p>
                </div>
                <span className={styles["account-badge"]}>
                  {account.onlineCount > 0 ? "active" : "idle"}
                </span>
              </div>
              <div className={styles["device-table"]}>
                <div className={styles["device-heading"]}>
                  <span>Device</span>
                  <span>IP / Location</span>
                  <span>Activity</span>
                  <span>Status</span>
                </div>
                {account.devices.map((device) => (
                  <DeviceRow device={device} key={device.deviceId} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </ErrorBoundary>
  );
}
