import { useState } from "react";

import styles from "./openclaw-auth-modal.module.scss";
import { IconButton } from "./button";
import { Modal, PasswordInput, showToast } from "./ui-lib";
import Locale from "../locales";

type OpenClawAuthMode = "login" | "guest";

export function OpenClawAuthModal(props: {
  onClose: () => void;
  onGuest: () => void;
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<OpenClawAuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (mode === "guest") {
      props.onGuest();
      return;
    }
    if (!username.trim() || !password) {
      showToast("请输入 OpenClaw 用户名和密码");
      return;
    }
    setLoading(true);
    try {
      await props.onLogin(username, password);
      props.onClose();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "OpenClaw 登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-mask">
      <Modal
        title="OpenClaw Access"
        onClose={props.onClose}
        className={styles.modal}
      >
        <div className={styles["openclaw-auth"]}>
          <div className={styles.hero}>
            <div className={styles["hero-row"]}>
              <div className={styles.mark}>OC</div>
              <div>
                <div className={styles.title}>连接你的 OpenClaw Agent</div>
                <div className={styles.subtitle}>
                  登录后可以进入授权 agent；游客模式会保留 NextChat 原本的模型与 API Key 功能。
                </div>
              </div>
            </div>
          </div>

          <div className={styles.tabs}>
            <div className={styles["tab-indicator"]} data-mode={mode} />
            <button
              className={styles.tab}
              data-active={mode === "login"}
              onClick={() => setMode("login")}
              type="button"
            >
              账号密码
            </button>
            <button
              className={styles.tab}
              data-active={mode === "guest"}
              onClick={() => setMode("guest")}
              type="button"
            >
              游客模式
            </button>
          </div>

          <div className={styles.panel} key={mode}>
            {mode === "login" ? (
              <div className={styles.fields}>
                <label className={styles.field}>
                  <div className={styles["field-title"]}>
                    <span>Username</span>
                    <span className={styles["field-hint"]}>agent access</span>
                  </div>
                  <div className={styles["input-wrap"]} data-kind="user">
                    <input
                      aria-label="OpenClaw Username"
                      type="text"
                      value={username}
                      autoComplete="username"
                      onChange={(e) => setUsername(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submit();
                      }}
                    />
                  </div>
                </label>
                <label className={styles.field}>
                  <div className={styles["field-title"]}>
                    <span>Password</span>
                    <span className={styles["field-hint"]}>private bridge</span>
                  </div>
                  <div className={styles["password-field"]} data-kind="key">
                    <PasswordInput
                      aria={Locale.Settings.ShowPassword}
                      aria-label="OpenClaw Password"
                      type="text"
                      value={password}
                      autoComplete="current-password"
                      onChange={(e) => setPassword(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submit();
                      }}
                    />
                  </div>
                </label>
              </div>
            ) : (
              <div className={styles["guest-panel"]}>
                <div className={styles["guest-orbit"]} />
                <div>
                  <div className={styles["guest-title"]}>继续使用 NextChat</div>
                  <div className={styles["guest-copy"]}>
                    游客模式不会连接你的 OpenClaw agent，仍可使用自己的 API Key 和其他平台模型。
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className={styles.actions}>
            <IconButton
              text={
                loading
                  ? "Loading..."
                  : mode === "guest"
                    ? "进入游客模式"
                    : Locale.UI.Confirm
              }
              type="primary"
              onClick={submit}
              bordered
              className={styles.primary}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
