// Public diagnostics are identifiers from this allowlist, NEVER exception text.
export const WARNING_DETAIL_LABELS = {
  'database-timeout': 'Вичерпано час очікування відповіді бази даних.',
  'database-unavailable': 'З’єднання з базою даних недоступне або перерване.',
  'database-tls': 'Не вдалося встановити захищене з’єднання з базою даних.',
  'database-authentication': 'База даних відхилила автентифікацію.',
  'database-access': 'База даних відхилила операцію через брак дозволів.',
  'database-connections': 'Досягнуто ліміту одночасних з’єднань із базою даних.',
  'database-schema': 'Схема бази даних не відповідає версії бота; перевірте міграції.',
  'database-conflict': 'Конфлікт транзакцій; операцію буде повторено.',
  'database-cancelled': 'Запит до бази даних скасовано.',
  'database-failure': 'Не вдалося виконати операцію з базою даних.',
  'gateway-disconnected': 'З’єднання з Discord перерване; очікується відновлення.',
  'guild-unavailable': 'Сервер Discord тимчасово недоступний.',
  'observation-gap': 'Завелика перерва між спостереженнями; непідтверджений час відкинуто.',
  'tracking-ownership': 'Інший екземпляр бота перехопив облік; перевірте дублікати запуску.',
  'tracking-unavailable': 'Облік голосового часу тимчасово недоступний.',
  'report-channel-unconfigured': 'Канал звітів не налаштовано; використайте /set-reputation-report.',
  'report-channel-missing': 'Канал звітів видалено або більше не існує.',
  'report-channel-invalid': 'Канал звітів має непридатний тип або належить іншому серверу.',
  'discord-view-channel': 'Немає дозволу View Channel у каналі звітів.',
  'discord-send-messages': 'Немає дозволу Send Messages у каналі звітів.',
  'discord-embed-links': 'Немає дозволу Embed Links у каналі звітів.',
  'discord-read-history': 'Немає дозволу Read Message History у каналі звітів.',
  'discord-permissions': 'Discord відхилив операцію через брак дозволів.',
  'discord-access': 'Discord відхилив доступ до каналу або повідомлення.',
  'discord-message-missing': 'Повідомлення звіту більше не існує.',
  'discord-rate-limit': 'Discord тимчасово обмежив частоту запитів.',
  'discord-timeout': 'Вичерпано час очікування відповіді Discord.',
  'discord-unavailable': 'Discord або мережеве з’єднання тимчасово недоступні.',
  'report-message-mismatch': 'Автор або службова позначка повідомлення звіту не збігається; редагування заблоковано.',
  'report-state': 'Стан доставки звіту потребує повторної перевірки.',
  'report-failure': 'Не вдалося доставити звіт; очікується повторна спроба.',
} as const;
export type WarningDetail = keyof typeof WARNING_DETAIL_LABELS;

export function safeWarningDetails(value: unknown): WarningDetail[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is WarningDetail =>
    typeof item === 'string' && Object.hasOwn(WARNING_DETAIL_LABELS, item)))].sort().slice(0, 4);
}

export class SafeOperationalError extends Error {
  readonly details: WarningDetail[];
  constructor(details: readonly WarningDetail[]) {
    super('Operational failure; see safe diagnostic identifiers.');
    this.details = safeWarningDetails(details);
  }
}

const databaseCodes: Record<string, WarningDetail> = {
  P1000: 'database-authentication', '28P01': 'database-authentication', '28000': 'database-authentication',
  P1010: 'database-access', '42501': 'database-access',
  P1001: 'database-unavailable', P1017: 'database-unavailable',
  P1002: 'database-timeout', P1008: 'database-timeout', P2024: 'database-timeout',
  P2021: 'database-schema', P2022: 'database-schema', '42P01': 'database-schema', '42703': 'database-schema',
  P2034: 'database-conflict', '40001': 'database-conflict', '40P01': 'database-conflict',
  '53300': 'database-connections', '57014': 'database-cancelled',
  '08000': 'database-unavailable', '08001': 'database-unavailable', '08003': 'database-unavailable',
  '08004': 'database-unavailable', '08006': 'database-unavailable',
  '57P01': 'database-unavailable', '57P02': 'database-unavailable', '57P03': 'database-unavailable',
};
const adapterKinds: Record<string, WarningDetail> = {
  DatabaseNotReachable: 'database-unavailable', ConnectionClosed: 'database-unavailable', SocketTimeout: 'database-timeout',
  AuthenticationFailed: 'database-authentication', DatabaseAccessDenied: 'database-access',
  TableDoesNotExist: 'database-schema', ColumnNotFound: 'database-schema', TooManyConnections: 'database-connections',
  TransactionWriteConflict: 'database-conflict', TlsConnectionError: 'database-tls',
};
const discordCodes: Record<string, WarningDetail> = {
  '10003': 'report-channel-missing', '10008': 'discord-message-missing',
  '50001': 'discord-access', '50013': 'discord-permissions', '429': 'discord-rate-limit',
};

// Inspect bounded structured code/cause fields only. Never parse/forward
// message, stack, SQL, URLs, server names, or credentials. Cycles/getters are safe.
export function classifyWarning(error: unknown, context: 'database' | 'discord'): WarningDetail[] {
  const pending = [error];
  const seen = new Set<object>();
  let fallback: WarningDetail = context === 'database' ? 'database-failure' : 'report-failure';
  for (let count = 0; pending.length && count < 32; count++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    try {
      if (value instanceof SafeOperationalError && value.details.length) return safeWarningDetails(value.details);
      const item = value as Record<string, unknown>;
      if (context === 'database' && typeof item.kind === 'string' && Object.hasOwn(adapterKinds, item.kind)) return [adapterKinds[item.kind]!];
      for (const field of ['code', 'originalCode', 'sqlState', 'status']) {
        const raw = item[field];
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        const code = String(raw);
        if (context === 'database' && Object.hasOwn(databaseCodes, code)) return [databaseCodes[code]!];
        if (context === 'discord' && Object.hasOwn(discordCodes, code)) return [discordCodes[code]!];
        if (['ETIMEDOUT','ESOCKETTIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT'].includes(code)) {
          return [context === 'database' ? 'database-timeout' : 'discord-timeout'];
        }
        if (['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','EPIPE'].includes(code)) {
          fallback = context === 'database' ? 'database-unavailable' : 'discord-unavailable';
        }
        if (context === 'discord' && /^5\d\d$/.test(code)) fallback = 'discord-unavailable';
      }
      for (const field of ['cause', 'meta', 'driverAdapterError', 'originalError', 'error', 'errors']) {
        const child = item[field];
        if (Array.isArray(child)) pending.push(...child.slice(0, 8));
        else if (child && typeof child === 'object') pending.push(child);
      }
    } catch { /* Broken getters must not expose data or break warning delivery. */ }
  }
  return [fallback];
}
