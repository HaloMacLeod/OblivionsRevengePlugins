import { React } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

const { ScrollView } = findByProps("ScrollView");
const { Stack, TableRow, TableRowGroup, TableSwitchRow, TextInput } = findByProps(
  "Stack",
  "TableRow",
  "TableRowGroup",
  "TableSwitchRow",
  "TextInput",
);

const OPTED_IN_USER_IDS = [
  "1412382371730161758",
  "1103168025403858954",
];

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