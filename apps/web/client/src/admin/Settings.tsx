/**
 * Admin → Settings: the Telegram bot and keys, the theme, money rules, support
 * contacts, messages and switches. The cards live in admin/settings/; each one
 * keeps its own unsaved edits while the others save (settings/context.tsx).
 */
import { useApi } from "../lib/useApi";
import { ErrorBox } from "../ui/kit";
import { AccountsCard } from "./Accounts";
import { BotCard, KeysCard } from "./settings/Connections";
import { SettingsProvider, type SettingsData } from "./settings/context";
import { LoyaltyCard, SafetyCard } from "./settings/LoyaltyCards";
import { DailyCard, EmailCard, LoginCard, PushCard, ServiceCard } from "./settings/MessageCards";
import { MaxPendingCard, NumbersCard, ReferralCard, StarsCard, SupportCard, SypCard, ThemeCard, TopupLimitsCard } from "./settings/StoreCards";

export function Settings() {
  const { data, error, reload } = useApi<SettingsData>("/api/admin/settings");
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <div className="skeleton" style={{ height: 240 }} />;
  return (
    <SettingsProvider settings={data.settings} reload={reload}>
      <div className="stack">
        <BotCard />
        <KeysCard />
        <AccountsCard />
        <ThemeCard />
        <SypCard />
        <ReferralCard />
        <SupportCard />
        <LoyaltyCard />
        <SafetyCard />
        <TopupLimitsCard />
        <StarsCard />
        <NumbersCard />
        <EmailCard />
        <LoginCard />
        <DailyCard />
        <PushCard />
        <ServiceCard />
        <MaxPendingCard />
      </div>
    </SettingsProvider>
  );
}
