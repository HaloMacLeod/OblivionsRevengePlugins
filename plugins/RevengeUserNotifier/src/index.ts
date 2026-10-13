import { findByProps, findByStoreName } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";
import { logPluginEvent } from "./logger";
import Settings from "./settings";

const OPTED_IN_USER_IDS = [
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

type LastSentState = {
  presence?: string;
  platforms?: string;
};

const lastSentState: Record<string, LastSentState> = {};
const recentNotifications = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 10_000;
let unpatchDispatch: (() => void) | null = null;
let unsubTyping: (() => void) | null = null;
let lastWebhookErrorAt = 0;
let loggedPresenceEventShape = false;

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
  if (!isDiscordWebhookUrl(webhookUrl)) {
    logPluginEvent(`Not sent: invalid or missing webhook URL (${title})`);
    return;
  }

  const now = Date.now();
  for (const [key, sentAt] of recentNotifications) {
    if (now - sentAt >= DUPLICATE_WINDOW_MS) recentNotifications.delete(key);
  }
  const notificationKey = JSON.stringify([webhookUrl, title, fields]);
  const lastSentAt = recentNotifications.get(notificationKey);
  if (lastSentAt !== undefined && now - lastSentAt < DUPLICATE_WINDOW_MS) {
    logPluginEvent(`Duplicate notification suppressed for 10 seconds: ${title}`);
    return;
  }
  recentNotifications.set(notificationKey, now);

  try {
    logPluginEvent(`Sending webhook: ${title}`);
    const response = await fetch(webhookUrl, {
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
    if (!response.ok) {
      const details = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${details ? `: ${details}` : ""}`);
    }
    logPluginEvent(`Webhook delivered: ${title} (HTTP ${response.status})`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logPluginEvent(`Webhook failed: ${title} (${reason})`);
    // Keep webhook failures from interrupting Discord's event dispatcher.
    const now = Date.now();
    if (now - lastWebhookErrorAt > 15_000) {
      lastWebhookErrorAt = now;
      showToast("RevengeUserNotifier: webhook delivery failed; check the URL and connection");
    }
  }
}

function userFields(id: string) {
  return [
    { name: "User", value: getUsername(id), inline: true },
    { name: "User ID", value: id, inline: true },
  ];
}

function onPresenceUpdate(payload: any) {
  const id = payload?.user?.id ?? payload?.userId ?? payload?.id;
  if (!OPTED_IN_USER_IDS.includes(id)) return;

  const current = getPresenceSnapshot(id);
  if (payload?.status) current.status = payload.status;
  if (payload?.client_status) {
    current.platforms = Object.fromEntries(
      Object.entries(payload.client_status).sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  const sentState = lastSentState[id];
  if (!sentState) {
    lastSentState[id] = {
      presence: current.status,
      platforms: JSON.stringify(current.platforms),
    };
    logPluginEvent(`Received presence for opted-in user ${id}; initialized snapshot`);
    return;
  }

  const activePlatforms = getActivePlatforms(current.platforms).join(", ") || "None reported";
  const platformState = JSON.stringify(current.platforms);
  if (sentState.presence === undefined && current.status) sentState.presence = current.status;
  if (sentState.platforms === undefined) sentState.platforms = platformState;
  const previousStatus = sentState.presence;
  const statusChanged = !!current.status && previousStatus !== undefined && previousStatus !== current.status;
  const platformsChanged = sentState.platforms !== undefined && sentState.platforms !== platformState;
  if (statusChanged && !storage.presenceAlerts) {
    logPluginEvent(`Presence changed for ${id}, but presence alerts are disabled`);
  }
  if (platformsChanged && !storage.platformAlerts) {
    logPluginEvent(`Platforms changed for ${id}, but platform alerts are disabled`);
  }

  if (storage.presenceAlerts && statusChanged) {
    sentState.presence = current.status;
    void sendWebhook(`${getUsername(id)} presence changed`, [
      ...userFields(id),
      { name: "Status", value: `${previousStatus} → ${current.status}`, inline: true },
    ]);
  }

  if (storage.platformAlerts && platformsChanged) {
    sentState.platforms = platformState;
    void sendWebhook(`${getUsername(id)} active platforms changed`, [
      ...userFields(id),
      { name: "Active platforms", value: activePlatforms },
    ]);
  }
}

function onPresenceEvent(payload: any) {
  const updates = Array.isArray(payload?.updates) ? payload.updates : [payload];
  const trackedUpdates = updates.filter((update: any) => {
    const id = update?.user?.id ?? update?.userId ?? update?.id;
    return OPTED_IN_USER_IDS.includes(id);
  });

  if (!loggedPresenceEventShape) {
    loggedPresenceEventShape = true;
    logPluginEvent(
      `Presence event ${payload?.type ?? "unknown"}: ${updates.length} update(s), ${trackedUpdates.length} for configured users`,
    );
  }

  for (const update of trackedUpdates) onPresenceUpdate(update);
}

function isDirectMessageWithUser(channel: any, userId: string) {
  if (!channel || channel.type !== 1 || channel.guild_id) return false;
  if (!Array.isArray(channel.recipients)) return true;
  return channel.recipients.some((recipient: any) =>
    (typeof recipient === "string" ? recipient : recipient?.id) === userId,
  );
}

function onTypingStart(payload: any) {
  const id = payload?.userId;
  if (!OPTED_IN_USER_IDS.includes(id)) return;
  if (!storage.typingAlerts) {
    logPluginEvent(`Typing event from opted-in user ${id} ignored; typing alerts are disabled`);
    return;
  }

  const channel = ChannelStore.getChannel(payload?.channelId);
  if (!isDirectMessageWithUser(channel, id)) {
    logPluginEvent(`Typing event from opted-in user ${id} ignored; channel was not their one-to-one DM`);
    return;
  }

  void sendWebhook(`${getUsername(id)} is typing in your DM`, userFields(id));
}

export default {
  onLoad() {
    logPluginEvent(`Plugin loaded; webhook URL ${isDiscordWebhookUrl(String(storage.webhookUrl ?? "").trim()) ? "is configured" : "is missing or invalid"}`);
    for (const id of OPTED_IN_USER_IDS) {
      const snapshot = getPresenceSnapshot(id);
      lastSentState[id] = {
        presence: snapshot.status,
        platforms: JSON.stringify(snapshot.platforms),
      };
    }

    unpatchDispatch = after("dispatch", FluxDispatcher, ([payload]) => {
      if (payload?.type === "PRESENCE_UPDATE" || payload?.type === "PRESENCE_UPDATES") {
        onPresenceEvent(payload);
      }
    });

    FluxDispatcher.subscribe("TYPING_START", onTypingStart);
    unsubTyping = () => FluxDispatcher.unsubscribe("TYPING_START", onTypingStart);

    if (storage.webhookUrl && !isDiscordWebhookUrl(String(storage.webhookUrl).trim())) {
      showToast("RevengeUserNotifier: enter a valid Discord webhook URL in settings");
    }
  },

  onUnload() {
    logPluginEvent("Plugin unloaded");
    unpatchDispatch?.();
    unsubTyping?.();
    unpatchDispatch = null;
    unsubTyping = null;
  },

  settings: Settings,
};