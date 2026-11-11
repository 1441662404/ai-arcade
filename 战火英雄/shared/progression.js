/**
 * 成长系统 —— 复刻原作「打得多就解锁更多武器/兵种」的正反馈。
 *
 * 设计原则：
 *   1. 纯函数式结算，便于服务端权威校验与客户端即时显示。
 *   2. 存档由客户端 localStorage 持有，服务端不信任上传值（只做上限校验）。
 *   3. 单人战役是主要的等级来源，多人对战也能积累经验。
 */

import { WEAPON_UNLOCK } from './weapons.js';
import { CLASS_UNLOCK } from './constants.js';

/** 升到 level 所需累计经验（宽松曲线，让前期快速解锁） */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  // 1级0，2级600，3级1500，4级2800……增长平缓
  return Math.round(600 * (level - 1) + 300 * (level - 1) * (level - 2) * 0.5);
}

/** 由累计经验反推等级 */
export function levelFromXp(xp) {
  let lv = 1;
  while (lv < 99 && xp >= xpForLevel(lv + 1)) lv++;
  return lv;
}

/** 当前等级内的进度（0-1），用于经验条 */
export function levelProgress(xp) {
  const lv = levelFromXp(xp);
  const cur = xpForLevel(lv);
  const next = xpForLevel(lv + 1);
  if (next <= cur) return 1;
  return Math.max(0, Math.min(1, (xp - cur) / (next - cur)));
}

/**
 * 对局结算：根据战绩算经验。
 * stats: { kills, deaths, score, headshots, win, mode, levelCleared, reward }
 */
export function matchXp(stats = {}) {
  const kills = stats.kills || 0;
  const deaths = stats.deaths || 0;
  let xp = kills * 25 + Math.max(0, (stats.score || 0) / 20) + (stats.headshots || 0) * 15;
  xp += stats.win ? 120 : 30;                       // 参与奖
  if (stats.mode === 'campaign' && stats.levelCleared) xp += (stats.reward || 80) * 2;
  xp -= Math.min(xp * 0.4, deaths * 4);             // 送人头小惩罚
  return Math.max(5, Math.round(xp));
}

/** 默认存档 */
export function defaultProfile() {
  return {
    v: 2,
    xp: 0,
    level: 1,
    kills: 0,
    deaths: 0,
    wins: 0,
    matches: 0,
    campaignProgress: 0,     // 已通关卡数
    campaignCleared: [],     // 已通关的关卡 id
    unlockedWeapons: [],     // 额外解锁（保留字段，主要靠等级自动解锁）
  };
}

/** 规范化来自 localStorage 的存档，防止脏数据 */
export function normalizeProfile(raw) {
  const d = defaultProfile();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  out.xp = Math.max(0, Math.min(9_999_999, Math.floor(Number(raw.xp) || 0)));
  out.kills = Math.max(0, Math.floor(Number(raw.kills) || 0));
  out.deaths = Math.max(0, Math.floor(Number(raw.deaths) || 0));
  out.wins = Math.max(0, Math.floor(Number(raw.wins) || 0));
  out.matches = Math.max(0, Math.floor(Number(raw.matches) || 0));
  out.campaignProgress = Math.max(0, Math.floor(Number(raw.campaignProgress) || 0));
  out.campaignCleared = Array.isArray(raw.campaignCleared)
    ? raw.campaignCleared.filter(x => typeof x === 'string').slice(0, 50)
    : [];
  out.unlockedWeapons = Array.isArray(raw.unlockedWeapons)
    ? raw.unlockedWeapons.filter(x => typeof x === 'string').slice(0, 80)
    : [];
  out.level = levelFromXp(out.xp);
  return out;
}

/** 把一局战绩并入存档，返回新存档与升级信息 */
export function applyMatch(profile, stats = {}) {
  const p = normalizeProfile(profile);
  const before = p.level;
  const gain = matchXp(stats);
  p.xp += gain;
  p.level = levelFromXp(p.xp);
  p.kills += stats.kills || 0;
  p.deaths += stats.deaths || 0;
  p.matches += 1;
  if (stats.win) p.wins += 1;
  if (stats.mode === 'campaign' && stats.levelCleared && stats.levelId) {
    if (!p.campaignCleared.includes(stats.levelId)) {
      p.campaignCleared.push(stats.levelId);
      p.campaignProgress = p.campaignCleared.length;
    }
  }
  return { profile: p, gain, levelUp: p.level > before, newLevel: p.level };
}

/** 某兵种是否已解锁 */
export function classUnlocked(cls, level) {
  const need = CLASS_UNLOCK[cls] || 0;
  return (level || 1) >= need;
}

/** 列出仍未解锁的兵种（给界面显示「还差 N 级」） */
export function lockedClasses(level) {
  const out = [];
  for (const [cls, need] of Object.entries(CLASS_UNLOCK)) {
    if ((level || 1) < need) out.push({ cls, need, gap: need - (level || 1) });
  }
  return out;
}

/** 列出仍未解锁的武器 */
export function lockedWeapons(level) {
  const out = [];
  for (const [wid, need] of Object.entries(WEAPON_UNLOCK)) {
    if ((level || 1) < need) out.push({ id: wid, need, gap: need - (level || 1) });
  }
  return out;
}

/** 下一个可解锁内容（用于「再打一局就解锁 X」的提示） */
export function nextUnlock(level) {
  let best = null;
  for (const [wid, need] of Object.entries(WEAPON_UNLOCK)) {
    if (need > (level || 1) && (!best || need < best.need)) best = { kind: 'weapon', id: wid, need };
  }
  for (const [cls, need] of Object.entries(CLASS_UNLOCK)) {
    if (need > (level || 1) && (!best || need < best.need)) best = { kind: 'class', id: cls, need };
  }
  return best;
}
