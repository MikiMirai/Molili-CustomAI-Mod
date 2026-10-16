/**
 * localapi.mjs — local answers for server endpoints that have no saved copy, so the game's panels keep working offline.
 *
 * Order used by the gateway (see answerFromFiles in molili-lmstudio.mjs):
 *   1. writeStub    harmless "save"/"ping" calls: always answered with success, never sent to the server
 *   2. saved data   diary, mail/favorites pages, exact copies saved in capture/
 *   3. fallbackStub an empty list, or a clear "not available offline" message
 * Nothing here ever changes your data: purchases, orders, rewards and tasks that need the server are refused.
 */
const ok = data => ({ status: 200, json: { success: true, code: 0, errCode: null, errMessage: null, ...(data === undefined ? {} : { data }) } });
const no = (errCode, errMessage) => ({ status: 400, json: { success: false, code: 400, errCode, errMessage, data: null } });
const pager = () => ({ records: [], total: 0, size: 20, current: 1, pages: 0, empty: true, notEmpty: false });
const list = () => ({ status: 200, json: { success: true, code: 0, errCode: null, errMessage: null, data: [], empty: true, notEmpty: false } });

const NEEDS_SERVER = 'Not available in local mode (it needs the Molili server).';
const NOT_SAVED = 'Not saved yet. Start the game once with the server reachable (LOGIN_MODE=auto) so it can be saved, then use local mode.';

const WRITE_OK = new Set([
  'agentApi/v1/updateLastActiveTime', 'userCompanionTaskApi/v1/cal', 'feedbackApi/v1/submit', 'favorApi/v1/addFavor',
  'favoriteApi/v1/add', 'favoriteApi/v1/remove', 'favoriteApi/v1/top', 'favoriteApi/v1/cancelTop',
  'userMailApi/v1/delete', 'userMailApi/v1/deleteRead',
]);
const EMPTY_ARRAY = new Set([
  'skillApi/v1/all', 'backPackApi/v1/categoryList', 'membershipApi/v1/list', 'userMembershipApi/v1/list',
]);
const EMPTY_PAGE = new Set([
  'userMailApi/v1/list', 'favoriteApi/v1/list', 'backPackApi/v1/items', 'feedbackApi/v1/exception/list', 'diaryApi/v1/pageQuery',
]);
const SAVED_ELSE_NOT_SAVED = new Set(['favorApi/v1/info', 'favorApi/v1/levelInfo', 'userCompanionTaskApi/v1/query', 'agentApi/v1/overview', 'userInfoApi/v1/getUserAsset']);
const NEEDS = new Set([
  'storeApi/v1/item/purchase', 'orderApi/v1/create', 'callbackApi/v1/payment/onSteamCallback', 'userMembershipApi/v1/dailyReward/receive',
  'favorApi/v1/receiveLevelReward', 'userMailApi/v1/reward/receive', 'userMailApi/v1/reward/receive/all', 'userMailApi/v1/detail',
  'chatApi/v1/tts', 'userCompanionTaskApi/v1/create', 'userCompanionTaskApi/v1/end', 'userCompanionTaskApi/v1/pause', 'userCompanionTaskApi/v1/resume',
  'backPackApi/v1/item/use', 'backPackApi/v1/item/unUse', 'fileApi/v1/sts',
]);

/** a success answer for calls that only record something on the server, or null */
export function writeStub(ep) { return WRITE_OK.has(ep) ? ok() : null; }

/** what to answer when nothing is saved for this request, or null (= unknown endpoint) */
/** the three Accompany tasks and their rates, as the server listed them in the recording */
export const COMPANION_TYPES = [
  { taskType: 'REST', companionObtainMax: 120, companionObtainPoint: 0, energyPerHour: 60, favorPerHour: 0, stardustPerHour: 0 },
  { taskType: 'WORK', companionObtainMax: 120, companionObtainPoint: 0, energyPerHour: 0, favorPerHour: 0, stardustPerHour: 60 },
  { taskType: 'STUDY', companionObtainMax: 20, companionObtainPoint: 1, energyPerHour: 0, favorPerHour: 10, stardustPerHour: 0 },
];
export function fallbackStub(ep) {
  if (ep === 'userCompanionTaskApi/v1/list') return ok(COMPANION_TYPES);
  if (ep === 'userMailApi/v1/unreadCount') return ok({ unreadCount: 0 });
  if (EMPTY_ARRAY.has(ep)) return list();
  if (EMPTY_PAGE.has(ep)) return ok(pager());
  if (SAVED_ELSE_NOT_SAVED.has(ep)) return no('NOT_SAVED', NOT_SAVED);
  if (NEEDS.has(ep) || /^orderApi\//.test(ep)) return no('LOCAL_MODE', NEEDS_SERVER);
  return null;
}
export const STUB_ENDPOINTS = [...WRITE_OK, ...EMPTY_ARRAY, ...EMPTY_PAGE, ...SAVED_ELSE_NOT_SAVED, ...NEEDS, 'userMailApi/v1/unreadCount'];
