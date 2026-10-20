import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const required = [
  'USERNAME', 'PASSWORD', 'DISCORD_WEBHOOK_URL',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

const {
  USERNAME, PASSWORD, DISCORD_WEBHOOK_URL,
} = process.env;

const LOGIN_URL = 'http://180.42.83.34/yoyaku/';
const MAIN_FRAME_SELECTOR = 'iframe#id_mainf';
const STATE_FILE = process.env.STATE_FILE || '.state/known-slots.json';

async function mainContent(page) {
  const frame = page.frameLocator(MAIN_FRAME_SELECTOR);
  return (await page.locator(MAIN_FRAME_SELECTOR).count()) ? frame : page;
}

function slotFromId(id) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d+)$/.exec(id);
  if (!match) return id;
  const [, year, month, day, period] = match;
  return `${year}/${month}/${day}・第${Number(period)}時限`;
}

function checkedAtJst() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short', hour12: false,
  }).format(new Date());
}

function targetDateIds() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  const start = new Date(Date.UTC(Number(value('year')), Number(value('month')) - 1, Number(value('day'))));
  return new Set(Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  }));
}

async function previousSlotIds() {
  try {
    return new Set(JSON.parse(await readFile(STATE_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

async function saveSlotIds(slots) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(slots.map((slot) => slot.id).sort()));
}

async function notify(message) {
  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: message }),
  });
  if (!response.ok) throw new Error(`Discord notification failed: ${response.status}`);
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.locator(MAIN_FRAME_SELECTOR).waitFor({ state: 'attached' });
  let content = page.frameLocator(MAIN_FRAME_SELECTOR);
  await content.locator('input[name="SEITONO"]').fill(USERNAME);
  await content.locator('input[name="ANSYONO"]').fill(PASSWORD);
  await content.locator('input[type="button"][value*="認"]').click();

  await content.locator('select[name="CBOSYA"]').waitFor();
  await content.locator('select[name="CBOSYA"]').selectOption({ label: '実車' });
  await content.locator('input[type="button"][value*="車種選択"]').click();

  await content.locator('td.Aki, td.Full').first().waitFor();
  const dateIds = targetDateIds();
  const slots = (await content.locator('td.Aki').evaluateAll((cells) =>
    cells.map((cell) => ({ id: cell.id, text: cell.textContent?.trim() ?? '' })),
  )).filter((slot) => dateIds.has(slot.id.slice(0, 8)));
  const previousIds = await previousSlotIds();
  const newSlots = slots.filter((slot) => !previousIds.has(slot.id));
  await saveSlotIds(slots);

  if (newSlots.length) {
    const details = newSlots.slice(0, 20).map((slot) => `• ${slotFromId(slot.id)}`);
    await notify(`🚗 実車の予約枠に新しい空きがあります\n${details.join('\n')}\n確認: ${checkedAtJst()}\n${LOGIN_URL}`);
    console.log(`Found ${newSlots.length} new slot(s).`);
  } else {
    await notify(`✅ 実車の予約枠を確認しました\n対象: 今日から7日間\n前回の確認以降、新しい空き枠はありません。\n現在の空き枠: ${slots.length}件\n確認: ${checkedAtJst()}`);
    console.log(`No new slots in the next 7 days (${slots.length} currently available).`);
  }
} finally {
  await browser.close();
}
