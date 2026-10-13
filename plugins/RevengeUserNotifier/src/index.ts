import { findByProps, findByStoreName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import Settings from "./settings";

const OPTED_IN_USER_IDS = [
  "1412382371730161758",
  "1103168025403858954",
];

const FluxDispatcher = findByProps("dispatch", "subscribe");
const PresenceStore = findByStoreName("PresenceStore");
const ChannelStore = findByProps("getChannel");
const UserStore = findByProps("getUser", "getCurrentUser");

const defaults = {
  webhookUrl: "",
  presenceAlerts: true,
  typingAlerts: true,
  platformAlerts: true,
};

for (const [key, value] of Object.entries(defaults)) {
  if (storage[key] === undefined) storage[key] = value;
}

type PresenceSnapshot = {
  status?: string;
  platforms: Record<string, string>;
};

const previous: Record<string, PresenceSnapshot> = {};
let unpatchDispatch: (() => void) | null = null;
let unsubTyping: (() => void) | null = null;

const getUsername = (id: string) => UserStore.getUser(id)?.username ?? id;

function getPresenceSnapshot(id: string): PresenceSnapshot {
  const state = PresenceStore.getState?.();
  const platforms = state?.clientStatuses?.[id] ?? {};
  return {
    status: PresenceStore.getStatus?.(id),
    platforms: Object.fromEntries(
      Object.entries(platforms).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function getActivePlatforms(platforms: Record<string, string>) {
  return Object.entries(platforms)
    .filter(([, status]) => status && status !== "offline")
    .map(([platform]) => platform);
}

function isDiscordWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["discord.com", "discordapp.com"].includes(url.hostname) &&
      /^\/api\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function sendWebhook(title: string, fields: { name: string; value: string }[]) {
  const webhookUrl = String(storage.webhookUrl ?? "").trim();
  if (!isDiscordWebhookUrl(webhookUrl)) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title,
          fields,
          timestamp: new Date().toISOString(),
        }],
        allowed_mentions: { parse: [] },
      }),
    });
  } catch {
    // Network failures should not interrupt Discord's event dispatcher.
  }
}

function userFields(id: string) {
  return [
    { name: "User", value: getUsername(id), inline: true },
    { name: "User ID", value: id, inline: true },
  ];
}

function onPresenceUpdate(payload: any) {
  const id = payload?.user?.id;
  if (!OPTED_IN_USER_IDS.includes(id)) return;

  const current = getPresenceSnapshot(id);
  if (payload?.status) current.status = payload.status;
  if (payload?.client_status) {
    current.platforms = Object.fromEntries(
      Object.entries(payload.client_status).sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  const old = previous[id];
  previous[id] = current;
  if (!old) return;

  if (storage.presenceAlerts && old.status && current.status && old.status !== current.status) {
    void sendWebhook(`${getUsername(id)} presence changed`, [
      ...userFields(id),
      { name: "Status", value: `${old.status} → ${current.status}`, inline: true },
    ]);
  }

  if (storage.platformAlerts && JSON.stringify(old.platforms) !== JSON.stringify(current.platforms)) {
    const platforms = getActivePlatforms(current.platforms);
    void sendWebhook(`${getUsername(id)} active platforms changed`, [
      ...userFields(id),
      { name: "Active platforms", value: platforms.length ? platforms.join(", ") : "None reported" },
    ]);
  }
}

function isDirectMessageWithUser(channel: any, userId: string) {
  if (!channel || channel.type !== 1 || channel.guild_id) return false;
  if (!Array.isArray(channel.recipients)) return true;
  return channel.recipients.some((recipient: any) =>
    (typeof recipient === "string" ? recipient : recipient?.id) === userId,
  );
}

function onTypingStart(payload: any) {
  if (!storage.typingAlerts) return;
  const id = payload?.userId;
  if (!OPTED_IN_USER_IDS.includes(id)) return;

  const channel = ChannelStore.getChannel(payload?.channelId);
  if (!isDirectMessageWithUser(channel, id)) return;

  void sendWebhook(`${getUsername(id)} is typing in your DM`, userFields(id));
}

export default {
  onLoad() {
    for (const id of OPTED_IN_USER_IDS) previous[id] = getPresenceSnapshot(id);

    unpatchDispatch = after("dispatch", FluxDispatcher, ([payload]) => {
      if (payload?.type === "PRESENCE_UPDATE") onPresenceUpdate(payload);
    });

    FluxDispatcher.subscribe("TYPING_START", onTypingStart);
    unsubTyping = () => FluxDispatcher.unsubscribe("TYPING_START", onTypingStart);

    if (storage.webhookUrl && !isDiscordWebhookUrl(String(storage.webhookUrl).trim())) {
      showToast("RevengeUserNotifier: enter a valid Discord webhook URL in settings");
    }
  },

  onUnload() {
    unpatchDispatch?.();
    unsubTyping?.();
    unpatchDispatch = null;
    unsubTyping = null;
  },

  settings: Settings,
};