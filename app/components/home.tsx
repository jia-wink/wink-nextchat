"use client";

require("../polyfill");

import { useEffect, useState } from "react";
import styles from "./home.module.scss";

import BotIcon from "../icons/bot.svg";
import LoadingIcon from "../icons/three-dots.svg";

import { getCSSVar, useMobileScreen } from "../utils";

import dynamic from "next/dynamic";
import { Path, ServiceProvider, SlotID } from "../constant";
import { ErrorBoundary } from "./error";

import { getISOLang, getLang } from "../locales";

import {
  HashRouter as Router,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { SideBar } from "./sidebar";
import { useAppConfig } from "../store/config";
import { AuthPage } from "./auth";
import { getClientConfig } from "../config/client";
import { type ClientApi, getClientApi } from "../client/api";
import { useAccessStore, useChatStore } from "../store";
import clsx from "clsx";
import {
  getOpenClawAuthState,
  heartbeatOpenClawPresence,
  loginOpenClaw,
  type OpenClawAuthState,
} from "../client/platforms/openclaw";
import { OpenClawAuthModal } from "./openclaw-auth-modal";

const OPENCLAW_FALLBACK_AGENT_ID = "main";
const OPENCLAW_FALLBACK_MODEL_ID = "default";

function getFirstScopedOpenClawAgent(
  agents: string[],
  fallback = OPENCLAW_FALLBACK_AGENT_ID,
) {
  return agents.find((agent) => agent && agent !== "*") ?? fallback;
}

export function Loading(props: { noLogo?: boolean }) {
  return (
    <div className={clsx("no-dark", styles["loading-content"])}>
      {!props.noLogo && <BotIcon />}
      <LoadingIcon />
    </div>
  );
}

const Artifacts = dynamic(async () => (await import("./artifacts")).Artifacts, {
  loading: () => <Loading noLogo />,
});

const Settings = dynamic(async () => (await import("./settings")).Settings, {
  loading: () => <Loading noLogo />,
});

const Chat = dynamic(async () => (await import("./chat")).Chat, {
  loading: () => <Loading noLogo />,
});

const NewChat = dynamic(async () => (await import("./new-chat")).NewChat, {
  loading: () => <Loading noLogo />,
});

const MaskPage = dynamic(async () => (await import("./mask")).MaskPage, {
  loading: () => <Loading noLogo />,
});

const PluginPage = dynamic(async () => (await import("./plugin")).PluginPage, {
  loading: () => <Loading noLogo />,
});

const SearchChat = dynamic(
  async () => (await import("./search-chat")).SearchChatPage,
  {
    loading: () => <Loading noLogo />,
  },
);

const Sd = dynamic(async () => (await import("./sd")).Sd, {
  loading: () => <Loading noLogo />,
});

const McpMarketPage = dynamic(
  async () => (await import("./mcp-market")).McpMarketPage,
  {
    loading: () => <Loading noLogo />,
  },
);

const OpenClawAdminPage = dynamic(
  async () => (await import("./openclaw-admin")).OpenClawAdminPage,
  {
    loading: () => <Loading noLogo />,
  },
);

export function useSwitchTheme() {
  const config = useAppConfig();

  useEffect(() => {
    document.body.classList.remove("light");
    document.body.classList.remove("dark");

    if (config.theme === "dark") {
      document.body.classList.add("dark");
    } else if (config.theme === "light") {
      document.body.classList.add("light");
    }

    const metaDescriptionDark = document.querySelector(
      'meta[name="theme-color"][media*="dark"]',
    );
    const metaDescriptionLight = document.querySelector(
      'meta[name="theme-color"][media*="light"]',
    );

    if (config.theme === "auto") {
      metaDescriptionDark?.setAttribute("content", "#151515");
      metaDescriptionLight?.setAttribute("content", "#fafafa");
    } else {
      const themeColor = getCSSVar("--theme-color");
      metaDescriptionDark?.setAttribute("content", themeColor);
      metaDescriptionLight?.setAttribute("content", themeColor);
    }
  }, [config.theme]);
}

function useHtmlLang() {
  useEffect(() => {
    const lang = getISOLang();
    const htmlLang = document.documentElement.lang;

    if (lang !== htmlLang) {
      document.documentElement.lang = lang;
    }
  }, []);
}

const useHasHydrated = () => {
  const [hasHydrated, setHasHydrated] = useState<boolean>(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  return hasHydrated;
};

const loadAsyncGoogleFont = () => {
  const linkEl = document.createElement("link");
  const proxyFontUrl = "/google-fonts";
  const remoteFontUrl = "https://fonts.googleapis.com";
  const googleFontUrl =
    getClientConfig()?.buildMode === "export" ? remoteFontUrl : proxyFontUrl;
  linkEl.rel = "stylesheet";
  linkEl.href =
    googleFontUrl +
    "/css2?family=" +
    encodeURIComponent("Noto Sans:wght@300;400;700;900") +
    "&display=swap";
  document.head.appendChild(linkEl);
};

export function WindowContent(props: { children: React.ReactNode }) {
  return (
    <div className={styles["window-content"]} id={SlotID.AppBody}>
      {props?.children}
    </div>
  );
}

function Screen() {
  const config = useAppConfig();
  const location = useLocation();
  const isArtifact = location.pathname.includes(Path.Artifacts);
  const isHome = location.pathname === Path.Home;
  const isAuth = location.pathname === Path.Auth;
  const isSd = location.pathname === Path.Sd;
  const isSdNew = location.pathname === Path.SdNew;

  const isMobileScreen = useMobileScreen();
  const shouldTightBorder =
    getClientConfig()?.isApp || (config.tightBorder && !isMobileScreen);

  useEffect(() => {
    loadAsyncGoogleFont();
  }, []);

  if (isArtifact) {
    return (
      <Routes>
        <Route path="/artifacts/:id" element={<Artifacts />} />
      </Routes>
    );
  }
  const renderContent = () => {
    if (isAuth) return <AuthPage />;
    if (isSd) return <Sd />;
    if (isSdNew) return <Sd />;
    return (
      <>
        <SideBar
          className={clsx({
            [styles["sidebar-show"]]: isHome,
          })}
        />
        <WindowContent>
          <Routes>
            <Route path={Path.Home} element={<Chat />} />
            <Route path={Path.NewChat} element={<NewChat />} />
            <Route path={Path.Masks} element={<MaskPage />} />
            <Route path={Path.Plugins} element={<PluginPage />} />
            <Route path={Path.SearchChat} element={<SearchChat />} />
            <Route path={Path.Chat} element={<Chat />} />
            <Route path={Path.Settings} element={<Settings />} />
            <Route path={Path.McpMarket} element={<McpMarketPage />} />
            <Route path={Path.OpenClawAdmin} element={<OpenClawAdminPage />} />
          </Routes>
        </WindowContent>
      </>
    );
  };

  return (
    <div
      className={clsx(styles.container, {
        [styles["tight-container"]]: shouldTightBorder,
        [styles["rtl-screen"]]: getLang() === "ar",
      })}
    >
      {renderContent()}
    </div>
  );
}

function OpenClawStartupAuthGate() {
  const accessStore = useAccessStore();
  const chatStore = useChatStore();
  const config = useAppConfig();
  const [dismissed, setDismissed] = useState(false);
  const [checkedStartupAuth, setCheckedStartupAuth] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const applyOpenClawAuth = (auth: OpenClawAuthState) => {
    const nextAgentId = getFirstScopedOpenClawAgent(auth.agents);
    const currentOpenClawModel =
      config.modelConfig.providerName === ServiceProvider.OpenClaw
        ? config.modelConfig.model
        : OPENCLAW_FALLBACK_MODEL_ID;

    accessStore.update((access) => {
      access.useCustomConfig = true;
      access.provider = ServiceProvider.OpenClaw;
      access.openclawUser = auth.username ?? "";
      access.openclawAllowedAgents = auth.agents;
      access.openclawAgentId = nextAgentId;
    });

    config.update((config) => {
      config.modelConfig.providerName = ServiceProvider.OpenClaw;
      config.modelConfig.model = currentOpenClawModel as any;
    });

    const currentSession = chatStore.currentSession();
    if (!currentSession || currentSession.messages.length > 0) {
      return;
    }

    chatStore.updateTargetSession(currentSession, (session) => {
      session.mask.modelConfig.providerName = ServiceProvider.OpenClaw;
      session.mask.modelConfig.model = currentOpenClawModel as any;
      session.openclaw = {
        ...session.openclaw,
        channel: "nextchat",
        agentId: nextAgentId,
        connectionStatus: session.openclaw?.connectionStatus ?? "connecting",
      };
    });
  };

  useEffect(() => {
    if (
      !accessStore.openclawEnabled ||
      accessStore.openclawUser ||
      dismissed ||
      checkedStartupAuth
    ) {
      return;
    }

    getOpenClawAuthState()
      .then((auth) => {
        accessStore.update((access) => {
          access.openclawUser = auth.username ?? "";
          access.openclawAllowedAgents = auth.agents;
        });
        if (!auth.authenticated) {
          setShowModal(true);
        } else {
          applyOpenClawAuth(auth);
        }
      })
      .finally(() => setCheckedStartupAuth(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accessStore.openclawEnabled,
    accessStore.openclawUser,
    checkedStartupAuth,
    dismissed,
  ]);

  useEffect(() => {
    if (!accessStore.openclawUser) {
      return;
    }

    heartbeatOpenClawPresence().catch((error) => {
      console.warn("[OpenClaw Presence] heartbeat failed", error);
    });
    const timer = setInterval(() => {
      heartbeatOpenClawPresence().catch((error) => {
        console.warn("[OpenClaw Presence] heartbeat failed", error);
      });
    }, 60 * 1000);

    return () => clearInterval(timer);
  }, [accessStore.openclawUser]);

  if (!showModal) {
    return null;
  }

  const close = () => {
    setDismissed(true);
    setShowModal(false);
  };

  return (
    <OpenClawAuthModal
      onClose={close}
      onGuest={() => {
        accessStore.update((access) => {
          access.provider =
            access.provider === ServiceProvider.OpenClaw
              ? ServiceProvider.OpenAI
              : access.provider;
        });
        close();
      }}
      onLogin={async (username, password) => {
        const auth = await loginOpenClaw(username, password);
        applyOpenClawAuth(auth);
        close();
      }}
    />
  );
}

export function useLoadData() {
  const config = useAppConfig();

  const api: ClientApi = getClientApi(config.modelConfig.providerName);

  useEffect(() => {
    (async () => {
      const models = await api.llm.models();
      config.mergeModels(models);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function Home() {
  useSwitchTheme();
  useLoadData();
  useHtmlLang();

  useEffect(() => {
    console.log("[Config] got config from build time", getClientConfig());
    useAccessStore.getState().fetch();
  }, []);

  if (!useHasHydrated()) {
    return <Loading />;
  }

  return (
    <ErrorBoundary>
      <Router>
        <Screen />
        <OpenClawStartupAuthGate />
      </Router>
    </ErrorBoundary>
  );
}
