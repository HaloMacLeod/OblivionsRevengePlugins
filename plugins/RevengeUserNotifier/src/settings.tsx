import { React } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showToast } from "@vendetta/ui/toasts";
import { logPluginEvent, type PluginLogEntry } from "./logger";

const { ScrollView } = findByProps("ScrollView");
const { Stack, TableRow, TableRowGroup, TableSwitchRow, TextInput } = findByProps(
  "Stack",
  "TableRow",
  "TableRowGroup",
  "TableSwitchRow",
  "TextInput",
);

const OPTED_IN_USER_IDS = [
  "1103168025403858954",
];

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

export default function Settings() {
  useProxy(storage);
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

  const update = (key: string, value: unknown) => {
    storage[key] = value;
    forceUpdate();
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10 }}>
      <Stack spacing={8}>
        <TableRowGroup title="Webhook">
          <Stack spacing={4} style={{ padding: 10 }}>
            <TextInput
              placeholder="https://discord.com/api/webhooks/..."
              value={storage.webhookUrl}
              onChange={(value: string) => update("webhookUrl", value)}
              isClearable
            />
          </Stack>
          <TableRow
            label="Tracked opted-in users"
            subLabel={OPTED_IN_USER_IDS.join(", ")}
          />
          <TableRow
            label="Send test notification"
            subLabel="Check that the configured webhook accepts messages"
            onPress={async () => {
              const webhookUrl = String(storage.webhookUrl ?? "").trim();
              if (!isDiscordWebhookUrl(webhookUrl)) {
                logPluginEvent("Test not sent: webhook URL is missing or invalid");
                showToast("RevengeUserNotifier: enter a valid Discord webhook URL first");
                return;
              }

              try {
                logPluginEvent("Sending test webhook");
                const response = await fetch(webhookUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    content: "RevengeUserNotifier test: webhook delivery is working.",
                    allowed_mentions: { parse: [] },
                  }),
                });
                if (!response.ok) {
                  const details = (await response.text().catch(() => "")).slice(0, 200);
                  throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${details ? `: ${details}` : ""}`);
                }
                logPluginEvent(`Test webhook delivered (HTTP ${response.status})`);
                showToast("RevengeUserNotifier: test notification sent");
              } catch (error) {
                const status = error instanceof Error ? error.message : "network error";
                logPluginEvent(`Test webhook failed (${status})`);
                showToast(`RevengeUserNotifier: test failed (${status})`);
              }
            }}
          />
        </TableRowGroup>

        <TableRowGroup title={`Logs (${Array.isArray(storage.webhookLogs) ? storage.webhookLogs.length : 0})`}>
          <TableRow
            label="Clear logs"
            subLabel="Remove saved diagnostic entries"
            onPress={() => {
              storage.webhookLogs = [];
              forceUpdate();
              showToast("RevengeUserNotifier: logs cleared");
            }}
          />
          {((Array.isArray(storage.webhookLogs) ? storage.webhookLogs : []) as PluginLogEntry[]).map((entry, index) => (
            <TableRow
              key={`${entry.timestamp}-${index}`}
              label={new Date(entry.timestamp).toLocaleString()}
              subLabel={entry.message}
            />
          ))}
          {(!Array.isArray(storage.webhookLogs) || storage.webhookLogs.length === 0) && (
            <TableRow label="No logs yet" subLabel="Webhook and event diagnostics will appear here" />
          )}
        </TableRowGroup>

        <TableRowGroup title="Notifications">
          <TableSwitchRow
            label="Presence changes"
            subLabel="Send online, idle, do-not-disturb, and offline transitions"
            value={storage.presenceAlerts}
            onValueChange={(value: boolean) => update("presenceAlerts", value)}
          />
          <TableSwitchRow
            label="Direct-message typing"
            subLabel="Only alert when an opted-in user types in their one-to-one DM with you"
            value={storage.typingAlerts}
            onValueChange={(value: boolean) => update("typingAlerts", value)}
          />
          <TableSwitchRow
            label="Active platform changes"
            subLabel="Report active desktop, mobile, or web sessions from presence data"
            value={storage.platformAlerts}
            onValueChange={(value: boolean) => update("platformAlerts", value)}
          />
        </TableRowGroup>

        <TableRowGroup title="Privacy and limitations">
          <TableRow
            label="Data sent"
            subLabel="The webhook receives opted-in user IDs, usernames, presence/platform changes, and DM typing events. Message contents are never sent."
          />
          <TableRow
            label="Invisible status"
            subLabel="Discord reports invisible users as offline to clients; this plugin cannot distinguish invisible from offline and will report the status provided by Discord."
          />
        </TableRowGroup>
      </Stack>
    </ScrollView>
  );
}