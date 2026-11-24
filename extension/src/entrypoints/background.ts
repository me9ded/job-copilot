import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { ALARMS, ensureAlarms } from '../background/alarms';
import { checkFollowUps, notifyNewMatches } from '../background/notify';
import { routeMessage, updateBadge } from '../background/router';
import { syncContentScripts } from '../background/registration';
import { clearDetection, forgetTab } from '../lib/detection';
import { runDiscovery } from '../lib/discovery/run';
import { runMigrations } from '../lib/storage/migrations';
import { KEYS, SESSION_KEYS } from '../lib/storage/schema';

const MENU_AUTOFILL = 'autofill-page';

/**
 * MV3 service worker. It can be suspended at any time, so:
 * - all listeners are registered synchronously at top level,
 * - no state is kept in memory between events (everything is in storage),
 * - long tasks (discovery) write progress as they go and are safe to re-run.
 */
export default defineBackground(() => {
  const ready = runMigrations(browser.storage.local).catch((err) => console.error('[job-copilot] migration failed', err));
  // The toolbar icon opens the popup (which grants access to the page through activeTab); its buttons
  // open the side panel. Earlier builds turned openPanelOnActionClick on and Chrome keeps that setting,
  // so it is switched off explicitly.
  const panelOnClick = () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  void panelOnClick();
  const setup = async () => {
    await ready;
    await panelOnClick();
    await Promise.allSettled([syncContentScripts(), ensureAlarms(), createMenus()]);
  };

  browser.runtime.onInstalled.addListener(() => void setup());
  browser.runtime.onStartup.addListener(() => void setup());

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    ready.then(() => routeMessage(message, sender)).then(sendResponse);
    return true; // keep the channel open for the async response
  });

  browser.permissions.onAdded.addListener((p) => {
    void syncContentScripts();
    if (p.permissions?.includes('notifications')) registerNotificationClicks();
  });
  browser.permissions.onRemoved.addListener(() => void syncContentScripts());

  // React to settings written by the UI (custom sites, schedules) without extra messages.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEYS.settings]) void Promise.allSettled([syncContentScripts(), ensureAlarms()]);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARMS.discovery) void ready.then(() => runDiscovery()).then((r) => notifyNewMatches(r.newJobs));
    else if (alarm.name === ALARMS.followUps) void ready.then(() => checkFollowUps());
  });

  // A navigation replaces the page, so the previous detection no longer applies.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') {
      void clearDetection(tabId);
      void updateBadge(tabId, null, false);
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

  // Right-click → "Autofill with Job Copilot" and the keyboard shortcut grant access to this page
  // (activeTab), open the panel, and ask it to autofill. Only the tab id is stored.
  const autofillFrom = (tab: { id?: number; windowId?: number } | undefined) => {
    if (!tab?.id || tab.windowId === undefined) return;
    // Open first: sidePanel.open must run synchronously within the user gesture.
    void browser.sidePanel.open({ windowId: tab.windowId });
    void browser.storage.session.set({ [SESSION_KEYS.autofillRequest]: { tabId: tab.id, at: Date.now() } });
  };
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_AUTOFILL) autofillFrom(tab);
  });
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'autofill-page') autofillFrom(tab);
  });

  registerNotificationClicks();
});

let notificationsHooked = false;
/** `chrome.notifications` only exists once the optional permission is granted. */
function registerNotificationClicks(): void {
  if (notificationsHooked || !browser.notifications) return;
  notificationsHooked = true;
  browser.notifications.onClicked.addListener((id) => {
    const view = id.startsWith('followup:') ? 'applications' : 'matches';
    void browser.tabs.create({ url: browser.runtime.getURL(`/dashboard.html#${view}`) });
    void browser.notifications.clear(id);
  });
}

async function createMenus(): Promise<void> {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: MENU_AUTOFILL,
    title: 'Autofill with Job Copilot',
    contexts: ['page', 'frame', 'editable'],
  });
}
