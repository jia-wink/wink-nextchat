import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { nextchatPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(nextchatPlugin);
