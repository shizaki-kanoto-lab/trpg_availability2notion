/**
 * Google カレンダーの予定から TRPG セッションの空き枠（朝・昼・夜）を判定し、
 * Web アプリで確認したうえで Notion データベースへ登録する。
 * 登録後は Discord に「◯月まで最新化しました」と通知する。
 *
 * 秘密情報・個人の設定はコードに書かず、スクリプトプロパティ
 * （エディタ左の「プロジェクトの設定」>「スクリプト プロパティ」）に登録する。
 *
 *   NOTION_TOKEN          必須  Notion インテグレーションのシークレット
 *   NOTION_DATABASE_ID    必須  空き枠を登録するデータベースの ID
 *   DISCORD_WEBHOOK_URL   任意  通知先チャンネルの Webhook URL（未設定なら通知しない）
 *   NOTION_PUBLIC_URL     任意  通知に載せる空き枠表の URL（Notion で Web 公開したページなど）
 *   EXCLUDE_CALENDARS     任意  判定から除外するカレンダー名（カンマ区切り）
 *   EVE_NG_CALENDAR_NAME  任意  「前日の夜を NG にする予定」を探すカレンダー名
 *   EVE_NG_KEYWORD        任意  その予定のタイトルに含まれる文字列
 *                               （2つとも設定したときだけ有効。例: 仕事のリリース日の前夜を空けない）
 */

// ===== 設定 =====
const PROPS = PropertiesService.getScriptProperties();
const NOTION_TOKEN = PROPS.getProperty('NOTION_TOKEN');
const NOTION_DATABASE_ID = PROPS.getProperty('NOTION_DATABASE_ID');
const DISCORD_WEBHOOK_URL = PROPS.getProperty('DISCORD_WEBHOOK_URL');
const NOTION_PUBLIC_URL = PROPS.getProperty('NOTION_PUBLIC_URL') || '';

const EXCLUDE_CALENDARS = (PROPS.getProperty('EXCLUDE_CALENDARS') || '')
  .split(',')
  .map(name => name.trim())
  .filter(name => name);
const EVE_NG_CALENDAR_NAME = PROPS.getProperty('EVE_NG_CALENDAR_NAME');
const EVE_NG_KEYWORD = PROPS.getProperty('EVE_NG_KEYWORD');

const TIME_ZONE = 'Asia/Tokyo';

// 判定する時間帯（夜は翌日0時まで）
const SLOTS = {
  morning: { startHour: 9, endHour: 12 },
  afternoon: { startHour: 13, endHour: 19 },
  night: { startHour: 21, endHour: 24 }
};

// Notion データベースのプロパティ名。自分のデータベースに合わせて変更する
const NOTION_PROPERTY = {
  title: '名前',      // タイトル
  date: '日付',       // 日付
  morning: '朝',      // セレクト（OK / NG）
  afternoon: '昼',    // セレクト（OK / NG）
  night: '夜',        // セレクト（OK / NG）
  note: '備考'        // テキスト
};
const NOTION_PAGE_TITLE = 'セッション可能';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function getRequiredProperty_(key) {
  const value = PROPS.getProperty(key);
  if (!value) {
    throw new Error(`スクリプトプロパティ「${key}」が設定されていません。`);
  }
  return value;
}

// ===== Webアプリを開いた時 =====
function doGet() {
  const template = HtmlService.createTemplateFromFile('index');
  template.availableDays = getAvailableDays();

  return template.evaluate()
    .setTitle('Notion空き枠追加確認');
}

function formatDate_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd');
}

// ===== 空き枠を取得 =====
function getAvailableDays() {
  // 実行日の翌日0時から、翌々月1日0時（翌月末まで）
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 1);

  // 終日予定で丸1日NGになる日
  const allDayNg = {};
  // 「前日の夜をNGにする予定」の前日（夜だけNG）
  const nightNg = {};
  // 時間指定の予定
  const timedEvents = [];

  // 自分が所有しているカレンダーから、期間内の予定をカレンダーごとに1回だけ取得
  const calendars = CalendarApp.getAllOwnedCalendars()
    .filter(calendar => !EXCLUDE_CALENDARS.includes(calendar.getName()));

  for (const calendar of calendars) {
    for (const event of calendar.getEvents(start, end)) {
      if (event.isAllDayEvent()) {
        // 複数日にまたがる終日予定は、その全日をNGにする
        const dayEnd = event.getAllDayEndDate();
        for (let d = event.getAllDayStartDate(); d < dayEnd; d.setDate(d.getDate() + 1)) {
          allDayNg[formatDate_(d)] = `終日予定: ${calendar.getName()} / ${event.getTitle()}`;
        }
        continue;
      }
      timedEvents.push({
        start: event.getStartTime(),
        end: event.getEndTime()
      });
    }
  }

  // 指定した予定の前日の夜をNGにする（除外カレンダーに入っていても判定する）
  // 期間最終日の翌日の予定も拾うため、1日先まで取得
  if (EVE_NG_CALENDAR_NAME && EVE_NG_KEYWORD) {
    const eveEnd = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    for (const calendar of CalendarApp.getCalendarsByName(EVE_NG_CALENDAR_NAME)) {
      for (const event of calendar.getEvents(start, eveEnd)) {
        if (!event.getTitle().includes(EVE_NG_KEYWORD)) {
          continue;
        }
        const eventDay = event.getStartTime();
        const dayBefore = new Date(eventDay.getFullYear(), eventDay.getMonth(), eventDay.getDate() - 1);
        nightNg[formatDate_(dayBefore)] = `前日の夜NG: ${event.getTitle()}`;
      }
    }
  }

  const availableDays = [];

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const date = formatDate_(d);

    if (allDayNg[date]) {
      Logger.log(`${date} NG理由: ${allDayNg[date]}`);
      continue;
    }

    const result = {};
    for (const [slot, { startHour, endHour }] of Object.entries(SLOTS)) {
      const slotStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour);
      const slotEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), endHour);
      result[slot] = isTimeSlotFree(timedEvents, slotStart, slotEnd);
    }

    if (nightNg[date]) {
      Logger.log(`${date} 夜NG理由: ${nightNg[date]}`);
      result.night = false;
    }

    // すべてNGの日は追加しない
    if (!result.morning && !result.afternoon && !result.night) {
      continue;
    }

    availableDays.push({
      date: date,
      displayDate: Utilities.formatDate(d, TIME_ZONE, 'yyyy/MM/dd'),
      morning: result.morning ? 'OK' : 'NG',
      afternoon: result.afternoon ? 'OK' : 'NG',
      night: result.night ? 'OK' : 'NG'
    });
  }

  return availableDays;
}

// ===== 指定時間帯が空いているか判定 =====
function isTimeSlotFree(timedEvents, slotStart, slotEnd) {
  return !timedEvents.some(event => event.start < slotEnd && event.end > slotStart);
}

// ===== Notion API共通 =====
function notionRequest_(method, path, body) {
  return {
    url: `${NOTION_API}${path}`,
    method: method,
    headers: {
      'Authorization': `Bearer ${getRequiredProperty_('NOTION_TOKEN')}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true
  };
}

// 複数リクエストを並列実行する（Notionのレート制限に合わせて3件ずつ、429は待って再試行）
function notionFetchAll_(requests) {
  const BATCH_SIZE = 3;
  const responses = [];

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    const batchResponses = UrlFetchApp.fetchAll(batch);

    for (let retry = 0; retry < 3; retry++) {
      const limited = batchResponses
        .map((res, j) => res.getResponseCode() === 429 ? j : -1)
        .filter(j => j >= 0);
      if (limited.length === 0) {
        break;
      }
      const retryAfter = Number(batchResponses[limited[0]].getHeaders()['Retry-After']) || 1;
      Utilities.sleep(retryAfter * 1000);
      const retried = UrlFetchApp.fetchAll(limited.map(j => batch[j]));
      limited.forEach((j, k) => { batchResponses[j] = retried[k]; });
    }

    responses.push(...batchResponses);
  }

  return responses;
}

function notionFetch_(method, path, body) {
  const response = notionFetchAll_([notionRequest_(method, path, body)])[0];
  if (response.getResponseCode() !== 200) {
    throw new Error(response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

// ===== Notionページの中身 =====
function buildSlotProperties_(day) {
  return {
    [NOTION_PROPERTY.morning]: { select: { name: day.morning } },
    [NOTION_PROPERTY.afternoon]: { select: { name: day.afternoon } },
    [NOTION_PROPERTY.night]: { select: { name: day.night } }
  };
}

function buildCreateRequest_(day) {
  if (!day.date) {
    throw new Error('日付情報がありません: ' + JSON.stringify(day));
  }
  return notionRequest_('post', '/pages', {
    parent: { database_id: getRequiredProperty_('NOTION_DATABASE_ID') },
    properties: {
      [NOTION_PROPERTY.title]: { title: [{ text: { content: NOTION_PAGE_TITLE } }] },
      [NOTION_PROPERTY.date]: { date: { start: day.date } },
      ...buildSlotProperties_(day),
      [NOTION_PROPERTY.note]: { rich_text: [{ text: { content: '' } }] }
    }
  });
}

function buildUpdateRequest_(pageId, day) {
  return notionRequest_('patch', `/pages/${pageId}`, {
    properties: buildSlotProperties_(day)
  });
}

function buildArchiveRequest_(pageId) {
  return notionRequest_('patch', `/pages/${pageId}`, { archived: true });
}

// ===== DBのページをまとめて取得（filter省略時は全件） =====
function queryNotionPages_(filter) {
  const pages = [];
  let startCursor = null;

  do {
    const body = { page_size: 100 };
    if (filter) {
      body.filter = filter;
    }
    if (startCursor) {
      body.start_cursor = startCursor;
    }
    const result = notionFetch_('post', `/databases/${getRequiredProperty_('NOTION_DATABASE_ID')}/query`, body);
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : null;
  } while (startCursor);

  return pages;
}

// ===== 選択された空き枠をNotionへ追加（Webアプリから呼ばれる） =====
function addSelectedToNotion(selectedDays, deleteExisting) {

  // JSON文字列なら配列へ戻す
  if (typeof selectedDays === 'string') {
    selectedDays = JSON.parse(selectedDays);
  }

  if (!Array.isArray(selectedDays)) {
    throw new Error('selectedDaysが配列ではありません: ' + JSON.stringify(selectedDays));
  }

  for (const day of selectedDays) {
    if (!day.date && day.displayDate) {
      day.date = day.displayDate.replace(/\//g, '-');
    }
  }

  if (deleteExisting) {
    archiveAllNotionPages();
  }

  // 対象期間の既存ページを1回で取得して日付ごとにまとめる
  const pagesByDate = {};
  if (!deleteExisting && selectedDays.length > 0) {
    const dates = selectedDays.map(day => day.date).sort();
    const existing = queryNotionPages_({
      and: [
        { property: NOTION_PROPERTY.date, date: { on_or_after: dates[0] } },
        { property: NOTION_PROPERTY.date, date: { on_or_before: dates[dates.length - 1] } }
      ]
    });
    for (const page of existing) {
      const dateProperty = page.properties[NOTION_PROPERTY.date].date;
      const date = dateProperty && dateProperty.start;
      if (date) {
        (pagesByDate[date] = pagesByDate[date] || []).push(page);
      }
    }
  }

  // 同じ日付なら先頭ページを更新して重複はアーカイブ、なければ作成
  const jobs = [];
  for (const day of selectedDays) {
    const pages = pagesByDate[day.date] || [];
    if (pages.length === 0) {
      jobs.push({ date: day.date, request: buildCreateRequest_(day) });
      continue;
    }
    jobs.push({ date: day.date, request: buildUpdateRequest_(pages[0].id, day) });
    for (const duplicate of pages.slice(1)) {
      jobs.push({ date: day.date, request: buildArchiveRequest_(duplicate.id) });
    }
  }

  const responses = notionFetchAll_(jobs.map(job => job.request));

  const failedDates = {};
  responses.forEach((response, i) => {
    if (response.getResponseCode() !== 200) {
      failedDates[jobs[i].date] = response.getContentText();
    }
  });

  const errors = Object.entries(failedDates).map(([date, message]) => `${date}: ${message}`);
  const success = selectedDays.length - errors.length;

  if (errors.length > 0) {
    return (
      `${success}件成功\n` +
      `${errors.length}件失敗\n\n` +
      errors.join('\n')
    );
  }
  sendDiscordUpdate(selectedDays);
  return `${success}件すべて追加しました。`;
}

function archiveAllNotionPages() {
  const pages = queryNotionPages_();
  const responses = notionFetchAll_(pages.map(page => buildArchiveRequest_(page.id)));
  const failed = responses.filter(res => res.getResponseCode() !== 200);
  if (failed.length > 0) {
    throw new Error(`${failed.length}件の削除に失敗しました: ${failed[0].getContentText()}`);
  }
  Logger.log(`既存ページを${pages.length}件削除しました`);
}

// ===== Discord通知 =====
// 同じ日に何度登録しても、通知は1日1回だけ（force=trueで強制送信）
function sendDiscordUpdate(selectedDays, force = false) {
  if (!DISCORD_WEBHOOK_URL || selectedDays.length === 0) {
    return;
  }

  const today = formatDate_(new Date());
  const lastSent = PROPS.getProperty('LAST_DISCORD_UPDATE');

  if (lastSent === today && !force) {
    Logger.log('Discord通知済みのためスキップ');
    return;
  }

  // 登録した中で一番先の日付の月を「◯月まで」とする
  const latestDate = selectedDays.map(day => day.date).sort().pop();
  const latestMonth = Number(latestDate.slice(5, 7));

  const message =
    `${today}\n` +
    `${latestMonth}月まで最新化しました` +
    (NOTION_PUBLIC_URL ? `\n${NOTION_PUBLIC_URL}` : '');

  UrlFetchApp.fetch(DISCORD_WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ content: message })
  });

  PROPS.setProperty('LAST_DISCORD_UPDATE', today);
}

// Discordに通知を1回送ってみる（1日1回の制限を無視して送信する）
function testDiscordNotification() {
  sendDiscordUpdate([{ date: formatDate_(new Date()) }], true);
}

// 「今日は通知済み」の記録を消す
function resetDiscordNotification() {
  PROPS.deleteProperty('LAST_DISCORD_UPDATE');
}

// ===== 設定確認（読み取りのみ・副作用なし） =====
function checkConfig() {
  const result = {};
  [
    'NOTION_TOKEN', 'NOTION_DATABASE_ID', 'DISCORD_WEBHOOK_URL', 'NOTION_PUBLIC_URL',
    'EXCLUDE_CALENDARS', 'EVE_NG_CALENDAR_NAME', 'EVE_NG_KEYWORD'
  ].forEach(key => {
    result[key] = PROPS.getProperty(key) ? 'set' : '-';
  });

  result.calendars = CalendarApp.getAllOwnedCalendars()
    .map(calendar => calendar.getName() + (EXCLUDE_CALENDARS.includes(calendar.getName()) ? '（除外）' : ''));

  if (EVE_NG_CALENDAR_NAME) {
    result.eveNgCalendar = CalendarApp.getCalendarsByName(EVE_NG_CALENDAR_NAME).length > 0 ? 'OK' : 'NOT FOUND';
  }

  if (NOTION_TOKEN && NOTION_DATABASE_ID) {
    const res = UrlFetchApp.fetch(`${NOTION_API}/databases/${NOTION_DATABASE_ID}`, {
      method: 'get',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION
      },
      muteHttpExceptions: true
    });
    result.notion = `HTTP ${res.getResponseCode()}`;
    if (res.getResponseCode() === 200) {
      const properties = JSON.parse(res.getContentText()).properties;
      const missing = Object.values(NOTION_PROPERTY).filter(name => !properties[name]);
      result.notionProperties = missing.length === 0 ? 'OK' : `MISSING: ${missing.join(', ')}`;
    }
  }

  if (DISCORD_WEBHOOK_URL) {
    const discord = UrlFetchApp.fetch(DISCORD_WEBHOOK_URL, { method: 'get', muteHttpExceptions: true });
    result.discord = `HTTP ${discord.getResponseCode()}`;
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
