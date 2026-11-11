/**
 * 武器库 —— 复刻原作「多武器池 + 兵种限制」的搭配感。
 * slot: primary 主武器 / secondary 副武器
 * classes: 允许装备的兵种（'*' 为全兵种可用）
 *
 * 所有数值同时被服务端模拟与客户端预测读取，务必保持双方一致。
 */

export const WEAPONS = {
  /* ---------------- 副武器 ---------------- */
  pistol: {
    id: 'pistol', name: 'M9 手枪', en: 'M9 Pistol', slot: 'secondary', classes: ['*'],
    desc: '可靠的副武器，弹匣打空时救你一命。',
    dmg: 17, rate: 5.5, auto: false, mag: 15, reserve: 8,
    reload: 1.15, spread: 0.012, moveSpread: 0.03, recoil: 0.9,
    speed: 1250, grav: 160, life: 0.8, pellets: 1, kick: 60,
    sfx: 'pistol', trace: '#ffd88a', icon: '🔫',
  },
  burst: {
    id: 'burst', name: '三连发手枪', en: 'Burst Pistol', slot: 'secondary', classes: ['*'],
    desc: '一次扳机三发点射，中距离爆发惊人。',
    dmg: 12, rate: 12, auto: false, mag: 21, reserve: 7, burst: 3, burstGap: 0.055,
    reload: 1.3, spread: 0.018, moveSpread: 0.038, recoil: 1.1,
    speed: 1300, grav: 150, life: 0.8, pellets: 1, kick: 75,
    sfx: 'pistol', trace: '#ffcf6b', icon: '🔫',
  },
  magnum: {
    id: 'magnum', name: '沙漠之鹰', en: 'Magnum', slot: 'secondary', classes: ['*'],
    desc: '一发入魂的重型手枪，后坐力也够你喝一壶。',
    dmg: 38, rate: 2.4, auto: false, mag: 7, reserve: 6,
    reload: 1.5, spread: 0.010, moveSpread: 0.05, recoil: 2.2,
    speed: 1500, grav: 170, life: 0.9, pellets: 1, kick: 200,
    sfx: 'magnum', trace: '#ffb347', icon: '🔥',
  },

  /* ---------------- 主武器 · 冲锋枪 ---------------- */
  smg: {
    id: 'smg', name: 'MP5 冲锋枪', en: 'MP5 SMG', slot: 'primary', classes: ['medic', 'sniper', 'assault'],
    desc: '射速快、后坐小，中近距离的最佳拍档。',
    dmg: 9, rate: 14, auto: true, mag: 30, reserve: 6,
    reload: 1.5, spread: 0.026, moveSpread: 0.035, recoil: 0.55,
    speed: 1150, grav: 200, life: 0.7, pellets: 1, kick: 32,
    sfx: 'smg', trace: '#cfe8ff', icon: '💨',
  },
  vector: {
    id: 'vector', name: '矢量冲锋枪', en: 'Vector', slot: 'primary', classes: ['assault', 'medic'],
    desc: '恐怖的射速，弹匣眨眼就空。近距离绞肉机。',
    dmg: 7, rate: 21, auto: true, mag: 26, reserve: 6,
    reload: 1.35, spread: 0.032, moveSpread: 0.032, recoil: 0.42,
    speed: 1100, grav: 210, life: 0.65, pellets: 1, kick: 26,
    sfx: 'smg', trace: '#bfe4ff', icon: '⚡',
  },

  /* ---------------- 主武器 · 步枪 ---------------- */
  rifle: {
    id: 'rifle', name: 'AK-74 突击步枪', en: 'AK-74', slot: 'primary', classes: ['assault', 'medic'],
    desc: '全距离通用的主力步枪，点射扫射两相宜。',
    dmg: 15, rate: 9, auto: true, mag: 30, reserve: 6,
    reload: 1.9, spread: 0.020, moveSpread: 0.030, recoil: 1.0,
    speed: 1400, grav: 180, life: 0.9, pellets: 1, kick: 85,
    sfx: 'rifle', trace: '#ffe08a', icon: '🪖',
  },
  m4: {
    id: 'm4', name: 'M4A1 卡宾枪', en: 'M4A1', slot: 'primary', classes: ['assault', 'sniper', 'medic'],
    desc: '精准度更高的卡宾枪，压枪轻松，适合稳健推进。',
    dmg: 13, rate: 10, auto: true, mag: 30, reserve: 6,
    reload: 1.8, spread: 0.014, moveSpread: 0.028, recoil: 0.72,
    speed: 1480, grav: 170, life: 0.95, pellets: 1, kick: 62,
    sfx: 'rifle', trace: '#ffe9a8', icon: '🎯',
  },
  scar: {
    id: 'scar', name: 'SCAR-H 战斗步枪', en: 'SCAR-H', slot: 'primary', classes: ['assault', 'sniper'],
    desc: '高伤害慢射速，三发之内解决战斗。',
    dmg: 26, rate: 5.2, auto: true, mag: 20, reserve: 6,
    reload: 2.1, spread: 0.016, moveSpread: 0.042, recoil: 1.7,
    speed: 1550, grav: 165, life: 1.0, pellets: 1, kick: 150,
    sfx: 'rifle', trace: '#ffd166', icon: '🦾',
  },

  /* ---------------- 主武器 · 机枪 ---------------- */
  mg: {
    id: 'mg', name: 'M249 轻机枪', en: 'M249 LMG', slot: 'primary', classes: ['medic', 'tank'],
    desc: '百发弹链持续压制，架住一个路口就是一道墙。',
    dmg: 12, rate: 11, auto: true, mag: 100, reserve: 4,
    reload: 3.6, spread: 0.030, moveSpread: 0.048, recoil: 0.95,
    speed: 1350, grav: 190, life: 0.9, pellets: 1, kick: 70,
    sfx: 'mg', trace: '#ffcf7a', icon: '🧱',
  },
  minigun: {
    id: 'minigun', name: '米尼岗转轮机枪', en: 'Minigun', slot: 'primary', classes: ['tank'],
    desc: '转起来就别想停。移动慢、预热长，但火力覆盖无死角。',
    dmg: 8, rate: 20, auto: true, mag: 150, reserve: 3,
    reload: 5.0, spread: 0.045, moveSpread: 0.06, recoil: 0.5, spinUp: 0.55,
    speed: 1200, grav: 200, life: 0.8, pellets: 1, kick: 24, moveMul: 0.62,
    sfx: 'minigun', trace: '#ffbe55', icon: '🌀',
  },

  /* ---------------- 主武器 · 霰弹枪 ---------------- */
  shotgun: {
    id: 'shotgun', name: 'SPAS-12 霰弹枪', en: 'SPAS-12', slot: 'primary', classes: ['tank', 'assault'],
    desc: '贴脸一枪一个，稍远就是挠痒痒。坦克兵的老伙计。',
    dmg: 11, rate: 1.5, auto: false, mag: 7, reserve: 5, pellets: 8,
    reload: 2.4, spread: 0.115, moveSpread: 0.02, recoil: 3.0,
    speed: 1050, grav: 380, life: 0.32, kick: 340,
    falloff: 0.55,
    sfx: 'shotgun', trace: '#ffc36b', icon: '💥',
  },
  autoShotgun: {
    id: 'autoShotgun', name: 'AA-12 自动霰弹', en: 'AA-12', slot: 'primary', classes: ['tank'],
    desc: '全自动霰弹，弹幕式覆盖。压得住就是神，压不住就是摆设。',
    dmg: 8, rate: 4.2, auto: true, mag: 20, reserve: 4, pellets: 6,
    reload: 3.0, spread: 0.095, moveSpread: 0.02, recoil: 1.6,
    speed: 1000, grav: 400, life: 0.30, kick: 170,
    falloff: 0.5,
    sfx: 'shotgun', trace: '#ffb84d', icon: '🧨',
  },

  /* ---------------- 主武器 · 狙击枪 ---------------- */
  sniper: {
    id: 'sniper', name: 'AWP 狙击枪', en: 'AWP', slot: 'primary', classes: ['sniper'],
    desc: '一发一个，爆头秒杀。开镜时视野拉近，别站着不动。',
    dmg: 88, rate: 0.85, auto: false, mag: 5, reserve: 5,
    reload: 2.9, spread: 0.002, moveSpread: 0.09, recoil: 3.4,
    speed: 2400, grav: 90, life: 1.6, pellets: 1, kick: 400,
    scope: true, laser: true,
    sfx: 'sniper', trace: '#a8ffcf', icon: '🎯',
  },
  semi: {
    id: 'semi', name: 'SVD 半自动狙击', en: 'SVD', slot: 'primary', classes: ['sniper'],
    desc: '半自动连点，容错率更高的中远距离杀手。',
    dmg: 46, rate: 2.2, auto: false, mag: 10, reserve: 5,
    reload: 2.5, spread: 0.006, moveSpread: 0.065, recoil: 2.0,
    speed: 2000, grav: 100, life: 1.4, pellets: 1, kick: 240,
    scope: true, laser: true,
    sfx: 'sniper', trace: '#9ff7c7', icon: '🔭',
  },

  /* ---------------- 主武器 · 爆炸物 / 特殊 ---------------- */
  rpg: {
    id: 'rpg', name: 'RPG-7 火箭筒', en: 'RPG-7', slot: 'primary', classes: ['assault'],
    desc: '一炮清一窝。弹道下坠明显，注意别对着自己脚下按。',
    dmg: 105, rate: 0.55, auto: false, mag: 1, reserve: 4,
    reload: 3.2, spread: 0.004, moveSpread: 0.05, recoil: 4.5,
    speed: 620, grav: 420, life: 3.0, pellets: 1, kick: 500,
    rocket: true, explode: { radius: 118, dmg: 78, self: 0.45 },
    sfx: 'rocket', trace: '#ff8b3d', icon: '🚀',
  },
  grenadeLauncher: {
    id: 'grenadeLauncher', name: '榴弹发射器', en: 'Grenade Launcher', slot: 'primary', classes: ['assault', 'tank'],
    desc: '抛物线榴弹，专治卡角落的老阴逼。',
    dmg: 40, rate: 1.6, auto: false, mag: 6, reserve: 4,
    reload: 2.8, spread: 0.012, moveSpread: 0.04, recoil: 2.2,
    speed: 780, grav: 900, life: 2.2, pellets: 1, kick: 280,
    rocket: true, explode: { radius: 92, dmg: 62, self: 0.4 },
    sfx: 'rocket', trace: '#ffd08a', icon: '💣',
  },
  railgun: {
    id: 'railgun', name: '磁轨炮', en: 'Railgun', slot: 'primary', classes: ['sniper'],
    desc: '蓄力后打出一道穿透一切的电磁束，一枪能串三个。',
    dmg: 125, rate: 0.5, auto: false, mag: 3, reserve: 5,
    reload: 3.4, spread: 0.0, moveSpread: 0.03, recoil: 5.0,
    speed: 3400, grav: 0, life: 1.2, pellets: 1, kick: 520,
    pierce: 3, charge: 0.7, beam: true,
    sfx: 'railgun', trace: '#8be9ff', icon: '⚡',
  },

  /* ---------------- 主武器 · 忍者专属 ---------------- */
  shuriken: {
    id: 'shuriken', name: '手里剑', en: 'Shuriken', slot: 'primary', classes: ['ninja'],
    desc: '弧形飞行的忍者暗器，命中即回旋。弹药几乎无限，适合持续骚扰。',
    dmg: 22, rate: 3.4, auto: true, mag: 24, reserve: 8, pellets: 1,
    reload: 1.6, spread: 0.030, moveSpread: 0.02, recoil: 0.5,
    speed: 1180, grav: 260, life: 1.1, kick: 50,
    spin: true, pierce: 1,
    sfx: 'slash', trace: '#7ff0dd', icon: '✴️',
  },
  smokeBomb: {
    id: 'smokeBomb', name: '烟雾弹', en: 'Smoke Bomb', slot: 'primary', classes: ['ninja'],
    desc: '投掷后生成遮蔽烟幕，进入其中的敌人视野受阻。',
    dmg: 12, rate: 1.2, auto: false, mag: 4, reserve: 4, pellets: 1,
    reload: 2.2, spread: 0.010, moveSpread: 0.03, recoil: 1.2,
    speed: 720, grav: 700, life: 1.6, kick: 90,
    smoke: { radius: 130, dur: 4 },
    sfx: 'rocket', trace: '#b8c6d8', icon: '💨',
  },

  /* ---------------- 主武器 · 近战 ---------------- */
  katana: {
    id: 'katana', name: '高频刀', en: 'Plasma Katana', slot: 'primary', classes: ['assassin', 'ninja'],
    desc: '一刀一个的玻璃大炮刺客，代价是必须贴到人家脸上。',
    dmg: 95, rate: 1.7, auto: true, mag: 0, reserve: 0,
    reload: 0, spread: 0, recoil: 0,
    melee: true, reach: 66, arc: 1.6,
    speed: 0, grav: 0, life: 0, pellets: 0, kick: 0,
    sfx: 'slash', trace: '#f9a8d4', icon: '🗡️',
  },
  shield: {
    id: 'shield', name: '防暴盾牌', en: 'Riot Shield', slot: 'primary', classes: ['tank'],
    desc: '按下蹲举盾，正面伤害大幅减免并反弹。推进利器。',
    dmg: 22, rate: 1.6, auto: true, mag: 0, reserve: 0,
    reload: 0, spread: 0, recoil: 0,
    shield: true, reach: 54, reduce: 0.82, reflect: 0.25,
    speed: 0, grav: 0, life: 0, pellets: 0, kick: 0,
    sfx: 'shield', trace: '#dfe7f5', icon: '🛡️',
  },
};

/* 兵种武器池（部署界面用） */
export const POOL = {
  assault: { primary: ['rifle', 'm4', 'scar', 'vector', 'smg', 'rpg', 'grenadeLauncher', 'shotgun'], secondary: ['pistol', 'burst', 'magnum'] },
  sniper:  { primary: ['sniper', 'semi', 'railgun', 'm4'], secondary: ['pistol', 'burst', 'magnum'] },
  medic:   { primary: ['mg', 'm4', 'rifle', 'smg', 'vector'], secondary: ['pistol', 'burst', 'magnum'] },
  tank:    { primary: ['minigun', 'mg', 'shotgun', 'autoShotgun', 'grenadeLauncher', 'shield'], secondary: ['pistol', 'burst', 'magnum'] },
  assassin: { primary: ['katana', 'vector', 'smg', 'autoShotgun'], secondary: ['magnum', 'pistol'] },
  ninja:    { primary: ['shuriken', 'smokeBomb', 'katana', 'smg', 'm4'], secondary: ['burst', 'pistol', 'magnum'] },
};

export const WEAPON_LIST = Object.keys(WEAPONS);

/**
 * 武器解锁等级（成长系统读取）。
 * 0 = 一开始就有；等级不足时部署界面显示锁定。
 * 让玩家从基础枪起步，逐步解锁高级货。
 */
export const WEAPON_UNLOCK = {
  pistol: 0, burst: 0, magnum: 2,
  smg: 0, vector: 4,
  rifle: 0, m4: 1, scar: 3,
  mg: 2, minigun: 6,
  shotgun: 0, autoShotgun: 5,
  sniper: 0, semi: 2, railgun: 7,
  rpg: 3, grenadeLauncher: 4,
  katana: 3, shield: 0,
  shuriken: 5, smokeBomb: 6,
};

/** 该武器在给定等级下是否已解锁 */
export function isWeaponUnlocked(id, level) {
  const need = WEAPON_UNLOCK[id] || 0;
  return (level || 0) >= need;
}

/** 取武器（带兜底） */
export function getWeapon(id) {
  return WEAPONS[id] || WEAPONS.pistol;
}

/** 该兵种可用的武器列表 */
export function weaponsFor(cls, slot) {
  const pool = POOL[cls] || POOL.assault;
  return (pool[slot] || []).map(id => WEAPONS[id]).filter(Boolean);
}

/** 每发子弹伤害（含距离衰减） */
export function damageAt(w, dist) {
  if (!w.falloff) return w.dmg;
  const t = Math.min(1, dist / 420);
  return w.dmg * (1 - (1 - w.falloff) * t);
}
